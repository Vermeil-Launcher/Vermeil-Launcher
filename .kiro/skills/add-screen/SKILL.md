---
name: add-screen
description: Add a new full-page screen/view to the launcher UI. Use when creating a new page, adding a new section to the sidebar, or implementing a new top-level view.
---

# Adding a New Screen

Follow this sequence when adding a new full-page view.

## 1. Create the Screen Component

File: `src/screens/<Name>.tsx`

```typescript
import { Component } from "solid-js";

const ScreenName: Component = () => {
  return (
    <div class="screen-enter">
      {/* Screen content */}
    </div>
  );
};

export default ScreenName;
```

Rules: one screen per file, PascalCase name matches filename, wrap in `screen-enter` div, default export.

## 2. Add to Screen Type Union

File: `src/App.tsx` — add to the `Screen` type union.

## 3. Import the Component

File: `src/App.tsx` — add the import.

## 4. Add the Show Conditional

File: `src/App.tsx` — inside `<div class="content">`:

```tsx
<Show when={activeScreen() === "new-screen"}><NewScreen /></Show>
```

## 5. Add Screen Title

File: `src/App.tsx` — in `screenTitles` record.

## 6. Add Sidebar Entry (if applicable)

File: `src/components/Sidebar.tsx` — navigation button calling `setActiveScreen()`.

## 7. Add Styles (if needed)

File: `src/styles/global.css` — use existing CSS variables.

## Verification

- Screen renders when navigated to
- Sidebar highlights correct item
- Titlebar shows correct title
- `screen-enter` animation plays
- No console errors
