# Daily

A small to-do app for your phone that backs everything up to a GitHub repository.

- **Daily:** habits that reset every morning. Each check adds to that habit's total and streak.
- **To do:** one-off tasks. When you check a task, it moves to the archive. Nothing is ever deleted.
- **Archive:** everything you've finished, grouped by day, with totals. You can move any task back to your list.
- Drag the `⋮⋮` handle to reorder items. Tap an item's text to edit it.
- Works offline. Changes are saved on the device and sent to GitHub after every edit, or as soon as the phone is back online.

## Where your data goes

Every change is committed to a GitHub repository you choose, in this layout:

```
Todo/
  data.json               everything the app knows (this is what a new phone loads)
  Todo.md                 today's habits and open tasks, as a normal markdown checklist
  Archive/2026-09-24.md   what you finished that day
```

The `.md` files are plain Obsidian-style checklists. If your Obsidian vault is in that repository (for example through the Obsidian Git plugin), set the app's **Folder** to a folder inside the vault. The app writes those files, so edit your lists in the app rather than in Obsidian; edits made in Obsidian get overwritten.

If you lose your phone, open the app on a new one and enter the same settings. Everything comes back. Also revoke the old token on GitHub.

## Setup

1. **Create a private repository for the data**, for example `todo-data`. It can be empty.
2. **Create a token** at GitHub → Settings → Developer settings → Fine-grained tokens:
   - Repository access: *Only select repositories* → `todo-data`
   - Permissions: **Contents → Read and write**
3. **Host the app:**
   - **GitHub Pages:** in this repository, go to Settings → Pages → Source: *GitHub Actions*, then push to `master`. The workflow publishes the `app/` folder. On the free plan, Pages only works for public repositories. The app code contains no personal data, so it's safe for this repository to be public.
   - **Cloudflare Pages** (works with a private repository): Workers & Pages → Create → Pages → connect this repository, set the build command to empty and the output directory to `app`.
4. On your phone, open the site, then use **Share → Add to Home Screen** (iPhone) or **Install app** (Android).
5. Tap the ⚙ button, enter your GitHub username, `todo-data` and the token, then tap **Save & sync**.

The ⚙ settings screen also has **Download backup**, which saves a JSON copy of everything.

## Running locally

```
python3 -m http.server -d app 8000
```

Then open http://localhost:8000.
