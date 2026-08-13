# Setting up Fantasy Analyst

**Deployment is automated.** Pushing to `main` builds, tests, migrates the
database and deploys to Cloudflare via GitHub Actions
(`.github/workflows/deploy.yml`). Nobody needs to run commands by hand.

Two repository secrets make that work (GitHub → Settings → Secrets and
variables → Actions):

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | lets the deploy talk to your Cloudflare account |
| `APP_PASSPHRASE` | the passphrase for making changes in the app |

Optionally `CLOUDFLARE_ACCOUNT_ID`, only if your token can see more than one
Cloudflare account.

## Who can see what

The site is public: anyone with the address can look at your rosters, rankings,
tallies and recommendations. That is deliberate — it keeps setup simple and
none of it is sensitive.

Changing anything is not public. Every action that writes — connecting Sleeper,
importing rankings, reviewing news, editing settings — needs the passphrase.
Without it, a stranger who found the address could poison your player tallies or
wipe your rankings, which is a security problem rather than a privacy one.

The rest of this page covers the manual parts: Part A is the one-time technical
setup (only needed if you ever deploy by hand instead of via GitHub), and Part B
is the normal in-app setup on your phone.

---

# Part A — one-time technical setup

You need a free Cloudflare account, and a domain name you control if you want
the newsletter address (step 5). Everything else is free.

Run the commands in a terminal, from the project folder.

## A1. Install and check

```bash
npm install
npm test
```

You should see all tests pass. If not, stop here — something is wrong with the
checkout, not with your setup.

## A2. Create the database

```bash
npx wrangler login          # opens a browser, sign in to Cloudflare
npx wrangler d1 create fantasy_analyst
```

The last command prints something like:

```
database_id = "b1e4c0de-1234-5678-9abc-def012345678"
```

Open `wrangler.toml` in a text editor, find the line:

```
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

and replace the quoted text with the id it printed. Save the file.

## A3. Create the tables

```bash
npx wrangler d1 migrations apply fantasy_analyst --remote
```

Answer yes if it asks for confirmation. This is safe to re-run: it only applies
migrations that have not been applied yet.

## A4. Set your password and signing key

```bash
npx wrangler secret put APP_PASSPHRASE
```

It will ask you to type a value. This is the password you will use to open the
app on your phone. Choose something long that you will remember.

```bash
npx wrangler secret put SESSION_SECRET
```

This one is not something you type by hand — it keeps your login secure. Paste a
long random value. To generate one:

```bash
openssl rand -hex 32
```

Copy the long string it prints and paste it as the value.

> These two values never appear in the app, in the code, or in your browser.

## A5. Turn on the newsletter address

This is what makes newsletters process automatically. Skip it and everything
else still works — you just will not have an inbound address yet, and the app
will say so.

You need a domain in Cloudflare. If your domain is `juncaj.net`, you will end up
with an address like `fantasy-news@juncaj.net`.

**In the Cloudflare dashboard (dash.cloudflare.com):**

1. Click your domain in the list.
2. In the left sidebar, click **Email** → **Email Routing**.
3. If you see a **Get started** / **Enable Email Routing** button, click it and
   accept the DNS records it offers to add. (Cloudflare adds MX records for you.
   Adding them is required — email cannot arrive without them.)
4. Wait until the status shows **Enabled**. This usually takes a minute or two.
5. Go to the **Routing rules** tab.
6. Click **Create address** (sometimes called *Custom address*).
7. In **Custom address**, type: `fantasy-news`
   — the domain part is filled in for you.
8. Under **Action**, choose **Send to a Worker**.
9. Under **Destination**, choose **fantasy-analyst**.
   *If the worker is not in the list, finish step A6 first (deploy), then come
   back and do steps 5–9.*
10. Click **Save**.

Now tell the app what its address is. Open `wrangler.toml`, find:

```
NEWSLETTER_ADDRESS = ""
```

and put your address between the quotes:

```
NEWSLETTER_ADDRESS = "fantasy-news@juncaj.net"
```

Save the file. (You can also set this later inside the app under
**Setup → Newsletter → Set the address manually**, which avoids editing files.)

## A6. Build and deploy

```bash
npm run build
npx wrangler deploy
```

At the end it prints a URL like `https://fantasy-analyst.<your-name>.workers.dev`.
That is your app. Open it on your iPhone and add it to your home screen.

If you did step A5 before deploying and the worker was not in the destination
list, go back and finish A5 now.

## A7. Check it works

Open the URL on your phone, enter your passphrase, and you should see the app.
Go to the **Setup** tab. Continue with Part B.

## What happens automatically after this

- Every Saturday evening and Sunday morning: refresh betting data (currently
  practice data only — no cost, no external calls).
- Every morning: refresh the NFL player list from Sleeper.
- Any time a newsletter arrives at your address: it is read and processed.

---

# Part B — normal setup, in the app

All of this happens on your phone in the **Setup** tab. Each row shows a status:

- ✅ done
- ⚠️ needs you
- ○ not started / optional

## B1. Sleeper

Tap **Sleeper**.

1. Type your Sleeper username (the one you log in to Sleeper with).
2. Check the season is right.
3. Tap **Connect**.
4. Tap **Update player list**. This downloads every NFL player so the app can
   recognise names in your newsletter. It takes a few seconds.

## B2. League

Tap **League**, then **Use this** next to the league you want.

If it warns that your team was not found, the Sleeper username you connected
does not own a team in that league — reconnect with the right username.

## B3. Underdog ADP

Tap **Underdog ADP**.

Download today's ADP from Underdog as a CSV, then either:

- tap **Choose a file** and pick it, or
- paste the contents into the box.

Tap **Import rankings**. You will then see exactly what happened:

- how many players were matched
- how many need a decision
- how many were not recognised
- how many rows were skipped, and why

Nothing is silently thrown away. Import a fresh file any time before your draft;
the newest one is the one used.

## B4. Newsletter

Tap **Newsletter**.

1. **Your Fantasy Analyst email address** is shown at the top. Tap
   **Copy address**.
   *If it says the address is not ready yet, Part A step A5 has not been done.*
2. Go to your FF Newsletter's website and change your subscription email to that
   address. (Or subscribe fresh with it and unsubscribe your personal address.)
3. Back in the app, type the address the newsletter arrives **from** — for
   example `newsletter@theirsite.com` — and tap **Save sender**.
   You can also enter just the domain, like `@theirsite.com`.

That is it. Every future issue is read automatically. You never forward
anything, and the app never touches your personal inbox.

Only mail from the sender you named is read. Anything else that reaches the
address is ignored and shown as "ignored" in the activity list.

Below that you can see:

- when the last email arrived and what happened to it
- how many news items were found
- how much good and bad news was applied automatically
- how many items are waiting for you in **Review**
- what the parser understood in each issue, and which sentences it could not
  interpret
- **Re-read this email** — after the rules improve, this shows exactly what
  would change before anything does: how many new items would be added and how
  each player's tally would move. Nothing changes until you tap the button. Any
  item you corrected yourself is never overwritten.

## B5. Vegas

Nothing to do. It shows as not connected, on purpose. Start/sit advice works
without it and says clearly when a betting line is missing rather than guessing.

---

# Everyday use

- **Review** — anything the app was not confident about. Accept, change, mark as
  the wrong player, or ignore. Your decisions always win, even if the same
  newsletter is read again.
- **Draft** — your draft board on draft day, with the reasoning behind every
  recommendation.
- **Team** — your roster, plus this week's lineup: the best line-up for your
  league's slots, which changes are worth making, and what each one is worth in
  points. You make the change in Sleeper; the app only advises.
- **Players** — search any player and read every piece of news the app has
  recorded about them.

# Things the app will never do

- Make a draft pick for you.
- Change your lineup.
- Send anything to Sleeper. It only reads.
- Invent a number when it does not know something — it says "unknown" instead.

---

# Running it on your own computer (optional)

```bash
npm run dev
```

Then open http://127.0.0.1:8787 and log in with `devpass`. This runs with made-up
demo data so you can look around without connecting anything real.

# For developers

`docs/ARCHITECTURE.md` explains the internals. Useful commands:

```bash
npm run typecheck
npm test                # unit + integration
npm run e2e             # iPhone-sized browser tests (needs: npx playwright install webkit)
npm run e2e:chromium    # same tests, fallback browser
npx wrangler deploy --dry-run   # check it builds without deploying
```
