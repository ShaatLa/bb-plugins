import { experimental_ThreadStatusGlyph as ThreadStatusGlyph } from '@get-bb/plugin-sdk/app';
// A small line-art robot for "still working": it walks right in profile, stops facing front with a thought bubble,
// walks back left and thinks again. One 8 s loop of pure CSS; with reduced motion bb's own spinner shows instead.
const css = `
.ar-move{animation:ar-move 8s linear infinite}
.ar-right{animation:ar-right 8s step-end infinite}
.ar-left{animation:ar-left 8s step-end infinite;opacity:0}
.ar-front{animation:ar-front 8s step-end infinite;opacity:0}
.ar-leg{transform-box:fill-box;transform-origin:50% 0;animation:ar-step .5s ease-in-out infinite alternate}
.ar-leg.b{animation-direction:alternate-reverse}
.ar-arm{transform-box:fill-box;transform-origin:50% 0;animation:ar-step .5s ease-in-out infinite alternate-reverse}
.ar-dot{animation:ar-dot 1.2s ease-in-out infinite;opacity:.2}
.ar-dot.b{animation-delay:.2s}.ar-dot.c{animation-delay:.4s}
@keyframes ar-move{0%{transform:translateX(-8px)}35%,50%{transform:translateX(8px)}85%,100%{transform:translateX(-8px)}}
@keyframes ar-right{0%{opacity:1}35%{opacity:0}}
@keyframes ar-left{0%{opacity:0}50%{opacity:1}85%{opacity:0}}
@keyframes ar-front{0%{opacity:0}35%{opacity:1}50%{opacity:0}85%{opacity:1}}
@keyframes ar-step{from{transform:rotate(-22deg)}to{transform:rotate(22deg)}}
@keyframes ar-dot{0%,100%{opacity:.2}50%{opacity:1}}
`;

// Profile facing right; the left-facing one mirrors it.
const side = <>
  <line x1="12" y1="2.5" x2="12" y2="4" /><rect x="8" y="4" width="8" height="7" rx="2" /><circle cx="14" cy="7.5" r=".9" />
  <rect x="9.5" y="12" width="5" height="6" rx="1" /><line className="ar-arm" x1="12" y1="13" x2="12" y2="16.5" />
  <line className="ar-leg" x1="11" y1="18" x2="11" y2="21.5" /><line className="ar-leg b" x1="13" y1="18" x2="13" y2="21.5" />
</>;

export function RobotLoader({ className = '', label = 'Still working' }: { className?: string; label?: string }) {
  return <span role="img" aria-label={label} className="inline-flex items-center"><span aria-hidden className="hidden items-center motion-reduce:inline-flex"><ThreadStatusGlyph indicator="runtime" size="compact" /></span>
  <svg aria-hidden viewBox="-10 -6 44 28" className={`h-5 w-auto overflow-visible motion-reduce:hidden ${className}`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <style>{css}</style>
    <g className="ar-move">
      <g className="ar-right">{side}</g>
      <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{side}</g></g>
      <g className="ar-front">
        <line x1="12" y1="2.5" x2="12" y2="4" /><rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10" cy="7.5" r=".9" /><circle cx="14" cy="7.5" r=".9" />
        <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="13" x2="17.5" y2="16.5" />
        <line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
        {/* The thought bubble: two rising puffs and a cloud with three pulsing dots. */}
        <circle cx="18" cy="2.5" r=".5" /><circle cx="19.5" cy="0.5" r=".8" />
        <rect x="18.5" y="-5.5" width="9" height="4.5" rx="2.2" />
        <circle className="ar-dot" cx="20.8" cy="-3.25" r=".5" fill="currentColor" stroke="none" /><circle className="ar-dot b" cx="23" cy="-3.25" r=".5" fill="currentColor" stroke="none" /><circle className="ar-dot c" cx="25.2" cy="-3.25" r=".5" fill="currentColor" stroke="none" />
      </g>
    </g>
  </svg></span>;
}
