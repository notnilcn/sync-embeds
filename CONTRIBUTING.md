# Contributing to Sync Embeds

Thanks for your interest in contributing!

## Reporting bugs & feature requests

Open a [GitHub Issue](https://github.com/uthvah/sync-embeds/issues) before writing any code. Include steps to reproduce for bugs, or a clear use-case for feature requests.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Install dependencies: `npm install`
3. Run the dev build (watches for changes): `npm run dev`
4. Make your changes in `src/`.
5. Test in an Obsidian vault by symlinking or copying the plugin folder.
6. Open a PR — link the relevant issue if one exists.

## Code style

- Plain JavaScript (no TypeScript required for small fixes).
- Keep changes focused; one concern per PR.
- Avoid adding new `!important` declarations to `styles.css` unless overriding Obsidian host styles that cannot be targeted with specificity alone.

## License

By contributing, you agree your code will be released under the [MIT License](LICENSE).
