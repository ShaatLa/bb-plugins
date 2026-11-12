import { createContext, useContext, useState } from 'react';
import { experimental_ThreadStatusGlyph as ThreadStatusGlyph } from '@get-bb/plugin-sdk/app';

// A small line-art robot that shows what the agent is doing. Each scene is one CSS loop on a shared figure:
// think — walks, stops facing front with a thought bubble (the default); write — sits at a desktop computer, typing;
// terminal — back to us at a screen of scrolling lines; fix — hammers a nail or turns a wrench; search — sweeps a
// magnifier; read — leafs through an endless paper scroll; wait — walks to and fro, kicking a pebble.
// With reduced motion bb's own spinner shows instead.
export type Activity = 'think' | 'write' | 'terminal' | 'fix' | 'search' | 'read' | 'wait';

// What the open chat's agent is doing now (see useAgentActivity); robots without their own activity follow it.
export const ActivityContext = createContext<Activity>('think');

const css = `
.ar-move{animation:ar-move 8s linear infinite}
.ar-right{animation:ar-right 8s step-end infinite}
.ar-left{animation:ar-left 8s step-end infinite;opacity:0}
.ar-front{animation:ar-front 8s step-end infinite;opacity:0}
.ar-bob{animation:ar-bob .25s ease-in-out infinite alternate}
.ar-leg,.ar-arm{transform-box:fill-box;transform-origin:50% 0}
.ar-leg{animation:ar-step .5s ease-in-out infinite alternate}
.ar-leg.b,.ar-arm{animation:ar-step .5s ease-in-out infinite alternate-reverse}
.ar-dot{animation:ar-dot 1.2s ease-in-out infinite;opacity:.2}
.ar-dot.b{animation-delay:.2s}.ar-dot.c{animation-delay:.4s}
.ar-type{transform-box:view-box;transform-origin:12px 13px;animation:ar-type .22s ease-in-out infinite alternate}
.ar-glow{animation:ar-dot .9s ease-in-out infinite;opacity:.2}.ar-glow.b{animation-delay:.3s}.ar-glow.c{animation-delay:.6s}
.ar-scroll{animation:ar-scroll 2.4s linear infinite}
.ar-tap{transform-box:view-box;animation:ar-tap .3s ease-in-out infinite alternate}
.ar-tap.l{transform-origin:6.5px 13px}.ar-tap.r{transform-origin:17.5px 13px;animation-direction:alternate-reverse}
.ar-hammer{transform-box:view-box;transform-origin:12px 13px;animation:ar-hammer .7s cubic-bezier(.6,0,.9,.5) infinite}
.ar-wrench{transform-box:view-box;transform-origin:22px 14.5px;animation:ar-wrench 1.1s ease-in-out infinite alternate}
.ar-lens{animation:ar-lens 2s ease-in-out infinite alternate}
.ar-paper{animation:ar-paper 1.6s linear infinite}
.ar-pebble{animation:ar-pebble 1s ease-out infinite}
.ar-kick{transform-box:fill-box;transform-origin:50% 0;animation:ar-kick 1s ease-in-out infinite}
.ar-plant{transform-box:fill-box;transform-origin:50% 0;animation:ar-plant 1s ease-in-out infinite}
.ar-sweep{transform-box:view-box;transform-origin:12px 13px;animation:ar-sweep 1.8s ease-in-out infinite alternate}
.ar-ask{animation:ar-ask 1.8s ease-in-out infinite alternate}
.ar-solid{fill:var(--background,#fff)}
@keyframes ar-move{0%{transform:translateX(-8px)}35%,50%{transform:translateX(8px)}85%,100%{transform:translateX(-8px)}}
@keyframes ar-right{0%{opacity:1}35%{opacity:0}}
@keyframes ar-left{0%{opacity:0}50%{opacity:1}85%{opacity:0}}
@keyframes ar-front{0%{opacity:0}35%{opacity:1}50%{opacity:0}85%{opacity:1}}
@keyframes ar-step{from{transform:rotate(-18deg)}to{transform:rotate(18deg)}}
@keyframes ar-bob{from{transform:translateY(0)}to{transform:translateY(-.6px)}}
@keyframes ar-dot{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes ar-type{from{transform:rotate(-4deg)}to{transform:rotate(5deg)}}
@keyframes ar-scroll{from{transform:translateY(0)}to{transform:translateY(-6px)}}
@keyframes ar-tap{from{transform:rotate(-8deg)}to{transform:rotate(8deg)}}
@keyframes ar-hammer{0%{transform:rotate(-40deg)}70%{transform:rotate(28deg)}100%{transform:rotate(-40deg)}}
@keyframes ar-wrench{from{transform:rotate(-28deg)}to{transform:rotate(22deg)}}
@keyframes ar-lens{0%{transform:translate(-1px,1px)}50%{transform:translate(2px,-1px)}100%{transform:translate(5px,1px)}}
@keyframes ar-paper{from{transform:translateY(0)}to{transform:translateY(2.4px)}}
@keyframes ar-pebble{0%,20%{transform:translate(0,0)}45%{transform:translate(2.6px,-2px)}70%,100%{transform:translate(4.5px,0)}}
@keyframes ar-kick{0%{transform:rotate(10deg)}25%{transform:rotate(-55deg)}45%{transform:rotate(0)}70%,100%{transform:rotate(10deg)}}
@keyframes ar-plant{0%,45%{transform:rotate(-8deg)}70%{transform:rotate(14deg)}100%{transform:rotate(-8deg)}}
@keyframes ar-sweep{from{transform:rotate(-12deg)}to{transform:rotate(14deg)}}
@keyframes ar-ask{from{transform:translateY(0);opacity:.5}to{transform:translateY(-1px);opacity:1}}
`;

const antenna = <line x1="12" y1="2.5" x2="12" y2="4" />;
// Profile facing right: head with one eye, body; the scenes add arms, legs and what the robot holds.
const sideHead = <>{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle cx="14" cy="7.5" r=".9" /></>;
const sideBody = <rect x="9.5" y="12" width="5" height="6" rx="1" />;
const standingLegs = <><line x1="12" y1="18" x2="12" y2="21.5" /><line x1="12.4" y1="18" x2="12.4" y2="21.5" /></>;
const front = <>{antenna}<rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10" cy="7.5" r=".9" /><circle cx="14" cy="7.5" r=".9" />
  <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></>;
const dots = (y: number, x0: number) => <><circle className="ar-dot" cx={x0} cy={y} r=".35" fill="currentColor" stroke="none" /><circle className="ar-dot b" cx={x0 + 2.2} cy={y} r=".35" fill="currentColor" stroke="none" /><circle className="ar-dot c" cx={x0 + 4.4} cy={y} r=".35" fill="currentColor" stroke="none" /></>;

// Walking in profile: legs scissor from one hip while the body bobs; the wait scene dribbles a pebble ahead.
const walker = (pebble: boolean) => <>
  <g className="ar-bob">{sideHead}{sideBody}<line className="ar-arm" x1="12" y1="13" x2="12" y2="16.5" /></g>
  {pebble ? <><line className="ar-plant" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-kick" x1="12" y1="18" x2="12" y2="21.5" />
    <circle className="ar-pebble" cx="14.4" cy="21.3" r=".6" fill="currentColor" stroke="none" /></>
    : <><line className="ar-leg" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-leg b" x1="12" y1="18" x2="12" y2="21.5" /></>}
</>;
const pacing = (bubble: boolean, pebble: boolean) => <g className="ar-move">
  <g className="ar-right">{walker(pebble)}</g>
  <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{walker(pebble)}</g></g>
  <g className="ar-front">{front}<line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="13" x2="17.5" y2="16.5" />
    {/* The thought bubble: two rising puffs and a cloud with three pulsing dots. */}
    {bubble && <><circle cx="18" cy="2.5" r=".5" /><circle cx="19.5" cy="0.5" r=".8" /><rect x="18.5" y="-5.5" width="9" height="4.5" rx="2.2" />{dots(-3.25, 20.8)}</>}
  </g>
</g>;

function Scene({ activity, fix }: { activity: Activity; fix: 'hammer' | 'wrench' }) {
  switch (activity) {
    case 'write': return <g transform="translate(-6 0)">
      {/* Sitting on a stool at a desk, typing on a desktop computer whose screen fills with lines. */}
      {sideHead}{sideBody}<line x1="9" y1="18.6" x2="13.5" y2="18.6" /><line x1="10.5" y1="18.6" x2="10.5" y2="21.5" />
      <path d="M12.4 18 H15.2 V21.5" /><line className="ar-type" x1="12" y1="13" x2="16.8" y2="14.4" />
      <line x1="15.5" y1="15" x2="29" y2="15" /><line x1="16.6" y1="15" x2="16.6" y2="21.5" /><line x1="28" y1="15" x2="28" y2="21.5" />
      <line x1="16.6" y1="14.6" x2="20.2" y2="14.6" /><rect x="21.4" y="13.8" width="1.4" height=".8" rx=".4" />
      <rect x="20" y="5.4" width="8.6" height="6.6" rx=".8" /><rect x="20.8" y="6.2" width="7" height="5" rx=".3" /><line x1="24.3" y1="12" x2="24.3" y2="13.6" /><line x1="22.8" y1="13.6" x2="25.8" y2="13.6" />
      <rect x="23.6" y="16.4" width="3.4" height="5.1" rx=".4" /><circle cx="25.3" cy="17.6" r=".3" fill="currentColor" stroke="none" />
      <line className="ar-glow" x1="21.8" y1="7.6" x2="26.4" y2="7.6" /><line className="ar-glow b" x1="21.8" y1="9" x2="25.6" y2="9" /><line className="ar-glow c" x1="21.8" y1="10.4" x2="24.4" y2="10.4" />
    </g>;
    case 'terminal': return <>
      {/* Back to us at a wide screen; output scrolls up inside it. */}
      <defs><clipPath id="ar-screen"><rect x="3.6" y="-2.4" width="18.8" height="8.8" /></clipPath></defs>
      <rect x="3" y="-3" width="20" height="10" rx="1" />
      <g clipPath="url(#ar-screen)"><g className="ar-scroll">{[15, 9, 18, 7, 12, 16, 8].map((end, i) => <line key={i} x1="5" y1={-0.5 + i * 2} x2={end + 3} y2={-0.5 + i * 2} />)}</g></g>
      <g transform="translate(-4 0)">{antenna}<rect className="ar-solid" x="7" y="4" width="10" height="7" rx="2" /><rect className="ar-solid" x="8.5" y="12" width="7" height="6" rx="1" />
        <line className="ar-tap l" x1="6.5" y1="13" x2="5" y2="10.5" /><line className="ar-tap r" x1="17.5" y1="13" x2="19" y2="10.5" />
        <line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></g>
    </>;
    case 'fix': return fix === 'hammer' ? <>
      {/* In profile, hammering a nail into a block. */}
      {sideHead}{sideBody}{standingLegs}<rect x="16.8" y="18.2" width="4.6" height="3.3" rx=".4" /><line x1="19.2" y1="16.8" x2="19.2" y2="18.2" /><line x1="18.4" y1="16.8" x2="20" y2="16.8" />
      <g className="ar-hammer"><line x1="12" y1="13" x2="19.6" y2="13" /><rect x="18.6" y="11" width="2.4" height="4" rx=".4" /></g>
    </> : <>
      {/* Facing us, turning a wrench on a bolt. */}
      {front}<line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="13" x2="18.6" y2="16" />
      <circle cx="22" cy="14.5" r="1" /><line x1="22" y1="14.5" x2="22" y2="21.5" />
      <g className="ar-wrench"><line x1="22" y1="14.5" x2="18.6" y2="16.4" /><path d="M23.4 13.4 A1.8 1.8 0 1 0 23.4 15.6" /></g>
    </>;
    case 'search': return <>
      {/* In profile, sweeping a big magnifier (thick rim, long handle) over the ground; a question mark bobs above. */}
      {sideHead}{sideBody}{standingLegs}<line x1="13" y1="21.5" x2="30" y2="21.5" />
      <circle cx="21" cy="21" r=".35" fill="currentColor" stroke="none" /><circle cx="25.5" cy="21" r=".35" fill="currentColor" stroke="none" />
      <g className="ar-sweep"><line x1="12" y1="13" x2="16.2" y2="15.6" /><line x1="16.2" y1="15.6" x2="18.2" y2="16.8" strokeWidth="1.6" />
        <circle cx="20.4" cy="18.1" r="2.5" strokeWidth="1.3" /><path d="M19.1 17.2 A1.6 1.6 0 0 1 20.4 16.4" /></g>
      <g className="ar-ask"><path d="M17.6 0.6 A1.3 1.3 0 1 1 18.9 1.9 V2.9" /><circle cx="18.9" cy="4.1" r=".3" fill="currentColor" stroke="none" /></g>
    </>;
    case 'read': return <>
      {/* In profile, leafing through a paper scroll that runs down to the floor and on. */}
      {sideHead}{sideBody}{standingLegs}<line x1="12" y1="13" x2="16" y2="12.6" />
      <line x1="16" y1="11.6" x2="21" y2="11.6" /><path d="M16.4 12 V20.2 Q16.4 21.5 18 21.5 H30" /><path d="M20.6 12 V19.8 Q20.6 20.6 21.6 20.6 H30" />
      <defs><clipPath id="ar-paper"><rect x="16.6" y="12.2" width="3.8" height="7.6" /></clipPath></defs>
      <g clipPath="url(#ar-paper)"><g className="ar-paper">{[0, 1, 2, 3, 4].map(i => <line key={i} x1="17.4" y1={10.4 + i * 2.4} x2={i % 2 ? 19 : 19.6} y2={10.4 + i * 2.4} />)}</g></g>
    </>;
    case 'wait': return pacing(false, true);
    default: return pacing(true, false);
  }
}

export function RobotLoader({ className = 'h-5', label = 'Still working', activity }: { className?: string; label?: string; activity?: Activity }) {
  const current = useContext(ActivityContext), shown = activity ?? current;
  // The fix scene picks its tool once per robot, at random.
  const [fix] = useState<'hammer' | 'wrench'>(() => Math.random() < .5 ? 'hammer' : 'wrench');
  return <span role="img" aria-label={label} data-activity={shown} className="inline-flex items-center"><span aria-hidden className="hidden items-center motion-reduce:inline-flex"><ThreadStatusGlyph indicator="runtime" size="compact" /></span>
    <svg aria-hidden viewBox="-10 -6 44 28" className={`w-auto overflow-visible motion-reduce:hidden ${className}`} fill="none" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" strokeLinejoin="round">
      <style>{css}</style>
      <Scene activity={shown} fix={fix} />
    </svg></span>;
}
