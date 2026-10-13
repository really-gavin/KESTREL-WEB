# Setting up the publish gateway (once, about 10 minutes)

The gateway is a small program that runs for free on Cloudflare. Kestrel OS sends your site to it, and it saves the site into the
KESTREL-WEB repository on GitHub. The GitHub key lives only in the gateway, never in the OS.

## 1. A GitHub token for the repository
1. On github.com open **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. Name: `kestrel-gateway`. Expiration: the longest you are comfortable with (you can make a new one later).
3. **Repository access: Only select repositories** > `KESTREL-WEB`.
4. **Permissions > Repository permissions > Contents: Read and write.** Nothing else.
5. Generate, and copy the token (it starts with `github_pat_`). You will paste it into Cloudflare in step 3.

## 2. A Worker on Cloudflare
1. Make a free account at cloudflare.com, then open **Workers & Pages > Create > Create Worker**. Name it `kestrel-web` and Deploy.
2. Click **Edit code**, delete what is there, paste the whole of `gateway/worker.js` from this repository, and **Deploy**.

## 3. Settings
In the Worker open **Settings > Variables and Secrets** and add:
- Text: `REPO` = `really-gavin/KESTREL-WEB`   (and `BRANCH` = `main` if your branch has another name)
- Secret: `GITHUB_TOKEN` = the token from step 1

Optional but recommended (limits abuse): **Storage & Databases > KV > Create** a namespace called `kestrel-limits`, then in the Worker
**Settings > Bindings > Add > KV namespace**, variable name `LIMITS`. This turns on limits: 3 new sites a day and 120 publishes an hour per
address, and a lock after 10 wrong passwords. Optional: a text variable `BLOCKLIST` = `badname,othername` to forbid some domain names.

## 4. Tell Kestrel where the gateway is
Your Worker's address looks like `https://kestrel-web.YOURNAME.workers.dev`. Put that single line in a file named `gateway.txt` at the top
of the KESTREL-WEB repository (replace the placeholder file). The Site Builder app reads it automatically, so no app update is needed if the
address ever changes.

## 5. Check it
Open the address in a browser: it should say "Kestrel Web gateway". Then in Kestrel OS run the Site Builder, pick a name, and publish.
In a minute or two the GitHub Action ("Rebuild the search index") adds the site to search.

## Notes
- Sites are published to `sites/<name>/` by the gateway. Every page is also kept as source text (`.kml`) so the Site Builder can reopen it.
- A site's password is stored only as a salted hash in `sites/<name>/.owner`. If someone forgets it, delete that site's folder in the repo.
- To remove a bad site or block a name, delete the folder or add the name to `BLOCKLIST`.
- Secure `kess://` sites are not publishable through the gateway. Add them yourself to `secure/<name>/`.

## If Cloudflare says "This uploader does not yet support projects that require a build process"
That message appears when a folder or several files are uploaded. Do not upload files. Use one of these instead:
- **Paste (easiest):** Workers & Pages > Create > Create Worker > Deploy the Hello World sample > **Edit code** > select all, delete, paste the whole of `worker.js` > Deploy.
- **Command line:** install Node.js, open a terminal in the `gateway` folder and run `npx wrangler login`, then `npx wrangler deploy`, then `npx wrangler secret put GITHUB_TOKEN` and paste the token. `wrangler.toml` here already holds the name and the REPO setting.
