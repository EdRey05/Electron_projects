# Publish the catalog with GitHub Pages

The site uses the Cayman theme, as in Streamlit_projects. index.md includes README.md directly, so edits to the app catalog update the site too. Relative demo-media links work in both locations. App-source links point at GitHub.

When the reviewed work is on main and pushed to GitHub:

1. Open the repository's Settings → Pages.
2. Under Build and deployment, select Deploy from a branch.
3. Select main and /(root), then save.
4. Wait for the Pages build/deployment to finish. The expected project URL is https://edrey05.github.io/Electron_projects/.

These files prepare the site; they do not change GitHub settings or publish anything by themselves. To preview another branch, choose that branch explicitly in Pages settings. Do not publish a branch until its content is ready for public use.

The site serves documentation and recordings, not the Windows executables themselves. Desktop apps still run locally. Binary release downloads can be attached to GitHub Releases later; the README currently avoids claiming those downloads exist.

See GitHub's [publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site). No Jekyll, Ruby, npm, or Node installation on this laptop is needed for GitHub's hosted Pages build.
