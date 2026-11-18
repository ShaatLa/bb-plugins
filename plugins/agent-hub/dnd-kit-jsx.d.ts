// @dnd-kit's typings still name the global JSX namespace, which React 19 types no longer declare.
import type { JSX as ReactJSX } from 'react';
declare global { namespace JSX { type Element = ReactJSX.Element; type IntrinsicElements = ReactJSX.IntrinsicElements; } }
