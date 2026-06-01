# @allenlabs/editor

A collaborative, block-based, **easily-editable** rich-text editor for React.
Slash commands (`/`), `@`-mentions, and real-time multi-user editing over
[Yjs](https://github.com/yjs/yjs). Built entirely on MIT-licensed pieces
([TipTap](https://tiptap.dev), Yjs, y-websocket). Backend-agnostic — point it
at any y-websocket-compatible server.

## Install

```bash
npm i @allenlabs/editor
# peers: react, react-dom
```

```ts
import '@allenlabs/editor/styles.css';
```

## Single-user

```tsx
import { CollaborativeEditor } from '@allenlabs/editor';

<CollaborativeEditor
  value="<p>Hello</p>"
  placeholder='Type "/" for commands…'
  onUpdate={(html) => save(html)}
/>;
```

## Real-time multi-user

Pass a `collab` config. The Yjs document becomes the source of truth; peers see
each other's carets.

```tsx
<CollaborativeEditor
  collab={{
    url: 'wss://your-host/editor',     // doc id is appended → /editor/<docId>
    docId: 'issue-42',                 // namespace however you like
    token: () => mintToken('issue-42'),// string or async fn (your auth)
    user: { name: 'Allen', color: '#22c55e' },
  }}
  mention={async (q) => searchPeople(q)} // [{ id, label }]
  onUpdate={(html) => snapshot(html)}     // optional DB snapshot
/>;
```

Any y-websocket server works (e.g. a Cloudflare Durable Object via
[`y-durableobjects`](https://github.com/napolab/y-durableobjects)). Auth is your
responsibility: mint a short-lived token bound to the `docId` and verify it on
the server before the WS upgrade.

## Customise the slash menu

```tsx
import { SlashCommand, DEFAULT_SLASH_ITEMS } from '@allenlabs/editor';
// pass your own items to SlashCommand.configure({ items: [...] })
```

## Blocks included

Paragraph, H1–H3, bullet/numbered/to-do lists, quote, code block, divider,
bold/italic/strike/inline-code, mentions. Extend with any TipTap extension.

## License

MIT.
