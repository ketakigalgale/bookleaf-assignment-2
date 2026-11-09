# BookLeaf Royalty Dashboard + n8n Notifications (Assignment 2)

Bubble app for authors and the BookLeaf ops team, n8n for the automation, and Gemini for writing the royalty summary emails. Everything is on Bubble's free plan.

**App (version-test):** https://ketakigalgale19.bubbleapps.io/version-test

| Login | Email | Password |
|---|---|---|
| Admin | admin@bookleaf.com | admin123 |
| Author | priya.sharma@email.com | Bookleaf@2026 |

Any other author from the dataset can make a login from the index page with **Sign Up** using their dataset email (for example sneha.kulkarni@email.com). The account gets linked to their author record automatically.

**Screen recording:** https://www.loom.com/share/68f48fa5d75a4322821accb6f92acc32

**n8n workflow export:** `n8n/bookleaf-royalty-summary.workflow.json`

The free plan can't publish to live or add collaborators, so I'm sharing the version-test link (as mentioned on the email thread).

---

## 1. What I built

- **Author portal** (`dashboard`): the author sees only their own books, with ISBN, genre, status, publication date, MRP, platforms, copies sold, earned, paid, pending and last payout date. Totals at the top and a green / yellow / red / grey badge on each book.
- **Admin portal** (`admin`): list of all authors with city, total books, total earned and pending. Search by name, filter by city and by status (fully paid / pending / overdue). A bulk button that sends summaries to every author with pending royalties, and a notification log at the bottom.
- **Author detail** (`admin_author`): the same view the author gets, plus payout history, notification history and the **Generate & Send Royalty Summary** button.
- **n8n workflow**: gets the request from Bubble, checks it, works out the numbers, asks Gemini to write the email, checks the email, and sends the result back to Bubble.

## 2. How the pieces connect

1. Admin clicks **Generate & Send** on an author's page.
2. Bubble first checks there is no summary for this author in the last 5 minutes (so double clicks don't send twice).
3. Bubble creates a NotificationLog with status *Processing*.
4. Bubble calls the n8n webhook through the API Connector. The request has a secret header (`X-BookLeaf-Key`) and the author's details plus all their books.
5. n8n validates it, calculates the totals and payout dates, calls Gemini, and checks the email it gets back.
6. n8n replies with the result (status, subject, email body, model, error if any).
7. Bubble saves that into the same log row as *Success* or *Failed*. The admin sees it in the notification log.

**Bulk send** reuses the same steps. The button puts every author with pending royalties (9 in the dataset) into a list in a page custom state (`bulk_queue`) and starts a custom event, `process_next`. That event takes the first author in the list, creates the log with trigger type *Bulk*, calls n8n, saves the result, removes the author from the list, and schedules itself again 5 seconds later until the list is empty. The 5-second gap keeps it inside Gemini's free rate limit. The button shows "Sending..." and can't be clicked while the list isn't empty. I first planned this with "Schedule API workflow on a list" (a backend loop), but that's blocked on the free plan (see below), so the loop runs on the page.

### Why the data goes in the webhook (and not through the Data API)

My first plan was the other way round: n8n would read the author from Bubble's Data API and then call back into a Bubble API workflow when done. When I tried it, Bubble returned:

> 401: This application does not expose an API. Please upgrade your Bubble subscription.

On the free plan nothing outside can call into Bubble. Calls going *out* (API Connector) still work. So Bubble sends everything n8n needs in the request, and n8n sends the result back in its response. The brief allows either way. The downside is that n8n trusts the numbers Bubble sends, which is why the webhook only accepts calls with the secret header.

I hit two more free-plan limits:
- **CSV upload is paid**, so I imported the dataset with a small temporary page. I uploaded the JSON to Bubble's file manager, read it through the API Connector, and used two "import next" buttons to create the authors and books.
- **A backend workflow can't run the API Connector call on the free plan.** I first put the n8n call inside a backend workflow. The database steps ran but the API call failed with *"This app reached a workflow limit available on the Free plan"*. I found this in the server logs and moved the call into the button's own workflow.

## 3. Database

| Type | What it holds | Main fields |
|---|---|---|
| User | Login | role (Author / Admin), author |
| Author | One per author | author_code, name, email, phone, city, joined_date, user, plus saved totals |
| Book | One per book | all dataset fields, status, print_partner, available_on (list), author, owner |
| Payout | Payout history | book, author, owner, amount, paid_on, is_opening_balance |
| NotificationLog | Every summary request | author, triggered_by, trigger_type, status, email_subject, email_body, email_delivery, error_stage, error_message, ai_model, completed_at |
| AppSettings | One row of rules | overdue_after_days (90), min_payout_threshold (1000), payout_window_days (45) |

Option sets: UserRole, BookStatus (the 9 production stages, with `is_published`), PrintPartner, Platform, NotificationStatus, EmailDelivery, TriggerType.

Why I set it up this way:
- **Book points to Author** instead of Author holding a list of books. Adding or moving a book is one change and searches stay simple.
- **Option sets** for every fixed list, so values can't be mistyped.
- **`owner` on Book and Payout.** I first wrote the privacy rule as "This Book's author's user is Current User", but Bubble greys out *Find this in searches* for rules that go two levels deep, so authors couldn't list their own books. Copying the user straight onto the book fixed it.
- **Totals saved on Author** (total books, earned, pending). The admin list needs to filter on them, and Bubble filters on saved fields. The author dashboard still adds up the books live.
- **`overdue_clock_start` date instead of an "overdue" flag.** A flag would go out of date the next day unless something updated it daily (a paid feature). The date the 90 days started (last payout, or publication if never paid) never goes stale, and the page compares it with today.
- **Payout history**: the dataset only has total paid and the last payout date per book, so each paid book has one payout row marked "Opening balance from dataset" instead of made-up transfers.

### Badge rules
- Green: nothing pending
- Red: something pending and more than 90 days since the last payout (or since publication if never paid)
- Yellow: pending but within 90 days
- Grey: still in production

All the payout dates in the dataset are from 2025, so today almost every book with a pending amount shows red.

## 4. Privacy rules

- On every type, "everyone else" can't see anything.
- Author: visible to the linked user and to admins.
- Book and Payout: visible to their `owner` and to admins.
- NotificationLog: admins only.
- Auto-binding is off everywhere, and roles can only be changed in the editor.

I tested it by logging in as Priya and opening Sneha's admin_author URL directly. The page loads but shows nothing, because the data is blocked on the server and not just hidden.

How author logins work: an author signs up with the email BookLeaf has for them. That runs a backend workflow (`claim_author_account`) which finds the Author with that email and links it to the new user (role, author, and owner on their books and payouts). In a real app I'd only do this after email verification.

## 5. The n8n workflow

| Node | What it does |
|---|---|
| Royalty Summary Webhook | POST, Header Auth. Wrong or missing key gets 403. |
| Config | Model name, the 90 / 1000 / 45 rules, email settings. No keys here. |
| Validate Request + Payload Valid? | Checks the request and cleans up the values. Rejects a log id it has already seen (replay). |
| Build Royalty Facts | Does all the maths: totals, which books are overdue, next payout date. |
| Build AI Request | Builds the prompt for this author. |
| Generate Email (Gemini) | Calls Gemini with a JSON schema. 20s timeout, one retry, error output goes to the failure path. |
| Validate AI Output + AI Output OK? | Checks the email before it goes anywhere. |
| Send Email? / Send Email (SMTP) | Optional real email. Turned off for now (`email_mode = off`). |
| Build Success / Failure Result | Builds the reply. The failure one says which step failed. |
| Respond to Bubble | Same reply format for every outcome. |

The Code nodes are also kept as separate files in `n8n/code/` with tests in `n8n/test/` (run `npm test`), so I could test the logic on my machine with the real dataset before putting it in n8n.

## 6. Prompt strategy

Model: Gemini (`gemini-3.5-flash-lite`), same provider as Assignment 1.

- **The AI doesn't do any maths.** n8n works out every total, the overdue status and the next payout date (quarter end + 45 days), formats the rupee amounts, and gives them to the model as text to copy.
- **Only the instructions that apply are sent.** An author with overdue books gets the "apologise and give a 48-hour update" instruction, a fully paid author gets a thank-you instead, and the production stages are only included if the author has a book in production. This keeps the email focused.
- **Knowledge Base and tone from Assignment 1** are in the system prompt: own the delay, give a concrete timeline, end with a clear next step, and never ask for bank details by email.
- **JSON output** with just `subject` and `body`, plain text, fixed greeting and sign-off.
- **Only the needed data** goes to the model: name and royalty figures, no email, phone or ids.
- **The email is checked after it comes back**: it must parse, not be cut off, greet the author by name, mention every book, and every ₹ amount must match the real data. If any check fails, the email isn't used and the log says why.

Edge cases in the data: authors never paid (AUTH003, AUTH006), books in production (AUTH007, AUTH009), pending under ₹1,000 (AUTH009, explained as rolling over), fully paid (AUTH008). The `examples/` folder has the exact prompts for two authors.

## 7. Errors and double clicks

| What goes wrong | What the admin sees in the log |
|---|---|
| n8n down, wrong secret, timeout | Failed, stage `webhook` |
| Bad data sent | Failed, with the validation message |
| Gemini error or rate limit | Failed, stage `ai_generation` |
| Gemini email has a wrong amount or missing book | Failed, stage `ai_output_validation`, with the reason |

There is no spinner: the log row is created first, so it always ends up as Success or Failed.

**Double clicks:** the button only runs if there's no Processing or Success log for that author in the last 5 minutes. n8n also refuses a log id it has already processed.

## 8. Limitations and what I'd change

- **Bulk send runs in the browser.** Because of the backend limit above, the bulk loop is a front-end loop, so the admin has to keep the admin page open until it finishes (about 30 seconds per author). On a paid plan I'd move it to "Schedule API workflow on a list" so it runs on the server.
- **Collaborator access**: Bubble asked for an upgrade when I tried to invite.
- The name search is case-sensitive, and the city/status dropdowns have no "All" option, so clearing a filter needs a page refresh.
- The ₹1,000 minimum is handled in the email but not in the badge and filter, so AUTH009 shows red in the UI.
- If the admin closes the tab while the call is running, the log can stay on Processing. A scheduled timeout check (paid plan) would fix that.
- On a paid plan I'd go back to n8n reading from the Data API and calling back to Bubble, so the page doesn't wait for the AI.

## 9. How I learned Bubble

Bubble was completely new to me. I was doing this alongside a full-time internship, mostly late at night, so I tried to learn only what I needed for each step.

I started with the database before touching any pages: option sets, data types, then privacy rules, because everything else depends on the field names being right. Coming from code, the biggest change in thinking was that privacy rules are the security layer. There's no backend code in between, so every type needs "everyone else sees nothing" plus clear owner and admin rules.

Mistakes I made and what I learned from them:
- **Typing instead of picking.** In the sign-up workflow I typed "Input email's value" as text instead of choosing it from the list, so Bubble tried to sign up a user whose email was literally that text. Since then I always check that dynamic values show up blue.
- **Field types can't be changed.** I created two date fields as numbers by mistake and had to delete and recreate them.
- **Two-level privacy rules don't allow search.** That's why Book and Payout have a direct `owner` field.
- **Dropping elements into a repeating group** was hard at first. When the cell was too small, things kept landing outside it. I learned to use the elements tree and to check the indent.
- **Free-plan limits, three times.** The Data API returned 401, CSV upload asked for an upgrade, and the n8n call failed inside a backend workflow. Each time I read the actual error and changed the design instead of upgrading.

The most useful skill was **debugging across two systems**. When the log stayed empty, I checked three places: n8n's executions (did the request arrive, and how long did it run), the output of each n8n node (what Validate Request rejected), and Bubble's server logs (which step ran or was skipped). That's how I found a lowercase "single" in the trigger type, a stray line break that broke the books JSON, and that Bubble puts the API response under `body`, so I had to read `Result of step 2's body's status`.

I used AI tools while building: for planning the structure, for the n8n code, and Bubble's own AI agent for some page layouts. Once the agent hid everything on the admin page, so I reverted its change and fixed the page by hand. I made sure I understand every workflow and n8n node so I can explain them.

With more time I'd make the royalty view a reusable element shared by the author and admin pages, add a reset button to the filters, and on a paid plan move the bulk loop to the server.
