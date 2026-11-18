UI components are vendored from get-bb/bb, tag desktop-v0.49.0 (MIT, Michael Yong).
components.json pins the official @bb registry for button, card, input, switch,
select, textarea and their dependencies. components/ui/settings-section.tsx
comes from apps/app/src/components/ui/settings-section.tsx at the same tag;
only its cn import points to the plugin-local copy. See LICENSE.bb.
