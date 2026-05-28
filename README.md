# 留痕

Astro source for https://thefriesrobber.github.io/.

## Local workflow

```sh
nvm install
nvm use
npm ci
npm run dev
```

Useful commands:

- `npm run build` checks and generates the static site into `dist`.
- `npm run preview` serves the generated `dist` output locally.

## Publishing

For the default user-site URL, the GitHub repository should be named
`TheFriesRobber.github.io`.

Build locally with `npm run build`, then publish the generated `dist` directory
to the `gh-pages` branch and configure GitHub Pages to serve that branch.
