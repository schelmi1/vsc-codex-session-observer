# Contributing

Thanks for improving Codex Session Observer.

## Development

Use the Node.js version in `.nvmrc`, then run:

```sh
npm ci
npm test
npm run test:ui
```

Use the **Run Codex Observer** launch configuration in VS Code to test the
extension against local sessions.

## Privacy rules

Never commit Codex transcripts, screenshots containing real session content,
credentials, tokens, absolute local paths, or tool input/output. Add a small,
sanitized fixture only when a parser regression needs one. The browser suite
already includes checks that private fixture data cannot reach the webview.

## Pull requests

Keep changes focused, explain user-visible behavior, and include tests for
parser, model, or UI changes. Run both test commands before requesting review.
For UI changes, include a sanitized screenshot when it makes the behavior easier
to assess.

## Scope

The observer remains local and read-only. Changes must not upload transcripts,
read `auth.json`, start Codex work, or alter source session files.
