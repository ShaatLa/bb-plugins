import { createContext, useContext, useState } from 'react';
import { experimental_ThreadStatusGlyph as ThreadStatusGlyph } from '@get-bb/plugin-sdk/app';

// A small line-art robot that shows what the agent is doing. Each scene is one CSS loop on a shared figure:
// think — walks, stops facing front with a thought bubble (the default); write — sits at a desktop computer, typing;
// terminal — back to us at a screen of scrolling lines; fix — hammers a nail or turns a wrench on a bolt; search — looks
// around through a magnifier; read — faces us over an open book, turning its pages; wait — walks to and fro, kicking a pebble;
// rest — the turn is over but background work runs: lies on a couch, breathing, Zzz rising.
// With reduced motion bb's own spinner shows instead.
export type Activity = 'think' | 'write' | 'terminal' | 'fix' | 'search' | 'read' | 'wait' | 'rest';

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
.ar-scroll{animation:ar-scroll 2.4s ease-out infinite}
.ar-tap{transform-box:view-box;transform-origin:17.5px 13px;animation:ar-tap .8s ease-in-out infinite}
.ar-hammer{transform-box:view-box;transform-origin:12px 13px;animation:ar-hammer 1.3s infinite}
.ar-pebble{animation:ar-pebble 2.2s ease-in-out infinite}
.ar-kick{transform-box:fill-box;transform-origin:50% 0;animation:ar-kick 2.2s ease-in-out infinite}
.ar-plant{transform-box:fill-box;transform-origin:50% 0;animation:ar-plant 2.2s ease-in-out infinite}
.ar-scan{transform-box:view-box;transform-origin:14.5px 13.2px;animation:ar-scan .9s ease-in-out infinite alternate}
.ar-look .ar-right,.ar-look .ar-left,.ar-look .ar-front{animation-duration:6s}
.ar-ask{animation:ar-ask 1.8s ease-in-out infinite alternate}
.ar-move.ar-quick{animation-name:ar-move-q}.ar-move.ar-quick,.ar-quick .ar-right,.ar-quick .ar-left,.ar-quick .ar-front{animation-duration:11s}.ar-quick .ar-right{animation-name:ar-right-q}.ar-quick .ar-left{animation-name:ar-left-q}.ar-quick .ar-front{animation-name:ar-front-q}
.ar-scratch{transform-box:view-box;transform-origin:16px 14.4px;animation:ar-scratch .3s ease-in-out infinite alternate}
.ar-z{animation:ar-z 2.4s linear infinite;opacity:0}
.ar-near{transform-box:view-box;transform-origin:14px 7.5px;animation:ar-near 1s ease-in-out infinite alternate}.ar-near.eye{animation-name:ar-near-eye}
.ar-spark{transform-box:view-box;transform-origin:19.2px 16.8px;animation:ar-spark 1.3s linear infinite;opacity:0}
.ar-solid{fill:var(--background,#fff)}
@keyframes ar-move-q{0%{transform:translateX(-8px)}46%,50%{transform:translateX(8px)}96%,100%{transform:translateX(-8px)}}
@keyframes ar-right-q{0%{opacity:1}46%{opacity:0}}
@keyframes ar-left-q{0%{opacity:0}50%{opacity:1}96%{opacity:0}}
@keyframes ar-front-q{0%{opacity:0}46%{opacity:1}50%{opacity:0}96%{opacity:1}}
@keyframes ar-scratch{from{transform:rotate(-12deg)}to{transform:rotate(6deg)}}
@keyframes ar-z{0%{transform:translate(0,0) scale(.7);opacity:0}20%{opacity:1}100%{transform:translate(5px,-9px) scale(1.2);opacity:0}}
@keyframes ar-near{from{transform:scale(1)}to{transform:scale(1.15)}}
@keyframes ar-near-eye{from{transform:scale(1)}to{transform:scale(1.25)}}
@keyframes ar-spark{0%,19%{opacity:0;transform:scale(.4)}21%{opacity:1;transform:scale(1)}36%,100%{opacity:0;transform:scale(1.3)}}
@keyframes ar-move{0%{transform:translateX(-8px)}35%,50%{transform:translateX(8px)}85%,100%{transform:translateX(-8px)}}
@keyframes ar-right{0%{opacity:1}35%{opacity:0}}
@keyframes ar-left{0%{opacity:0}50%{opacity:1}85%{opacity:0}}
@keyframes ar-front{0%{opacity:0}35%{opacity:1}50%{opacity:0}85%{opacity:1}}
@keyframes ar-step{from{transform:rotate(-18deg)}to{transform:rotate(18deg)}}
@keyframes ar-bob{from{transform:translateY(0)}to{transform:translateY(-.6px)}}
@keyframes ar-dot{0%,100%{opacity:.2}50%{opacity:1}}
@keyframes ar-type{from{transform:rotate(-4deg)}to{transform:rotate(5deg)}}
@keyframes ar-scroll{0%,20%{transform:translateY(0)}33.3%,53.3%{transform:translateY(-2px)}66.6%,86.6%{transform:translateY(-4px)}100%{transform:translateY(-6px)}}
@keyframes ar-tap{0%,45%{transform:rotate(-10deg)}60%{transform:rotate(10deg)}100%{transform:rotate(-10deg)}}
@keyframes ar-hammer{0%{transform:rotate(-40deg);animation-timing-function:cubic-bezier(.55,0,1,.6)}20%,45%{transform:rotate(14deg);animation-timing-function:ease-in-out}100%{transform:rotate(-40deg)}}
@keyframes ar-pebble{0%,15%{transform:translate(0,0)}28%{transform:translate(1.9px,-1.8px)}45%{transform:translate(3.4px,0)}100%{transform:translate(0,0)}}
@keyframes ar-kick{0%{transform:rotate(0)}18%{transform:rotate(-55deg)}32%{transform:rotate(0)}50%{transform:rotate(20deg)}67%{transform:rotate(-20deg)}84%{transform:rotate(20deg)}100%{transform:rotate(0)}}
@keyframes ar-plant{0%{transform:rotate(0)}18%{transform:rotate(8deg)}32%{transform:rotate(0)}50%{transform:rotate(-20deg)}67%{transform:rotate(20deg)}84%{transform:rotate(-20deg)}100%{transform:rotate(0)}}
@keyframes ar-scan{from{transform:rotate(-9deg)}to{transform:rotate(7deg)}}
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

// Walking in profile: legs scissor from one hip while the body bobs; the thinking robot scratches its chin; the wait scene dribbles a pebble ahead and turns
// back quickly (ar-quick) instead of pausing to face us.
const walker = (pebble: boolean) => <>
  <g className="ar-bob">{sideHead}{sideBody}{pebble ? <line className="ar-arm" x1="12" y1="13" x2="12" y2="16.5" />
    : <><line x1="12" y1="13" x2="16" y2="14.4" /><line className="ar-scratch" x1="16" y1="14.4" x2="15.3" y2="11.8" /></>}</g>
  {pebble ? <><line className="ar-plant" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-kick" x1="12" y1="18" x2="12" y2="21.5" />
    <circle className="ar-pebble" cx="14.4" cy="21.3" r=".6" fill="currentColor" stroke="none" /></>
    : <><line className="ar-leg" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-leg b" x1="12" y1="18" x2="12" y2="21.5" /></>}
</>;
const pacing = (bubble: boolean, pebble: boolean) => <g className={pebble ? 'ar-move ar-quick' : 'ar-move'}>
  <g className="ar-right">{walker(pebble)}</g>
  <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{walker(pebble)}</g></g>
  <g className="ar-front">{front}<line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="13" x2="17.5" y2="16.5" />
    {/* The thought bubble: two rising puffs and a cloud with three pulsing dots. */}
    {bubble && <><circle cx="18" cy="2.5" r=".5" /><circle cx="19.5" cy="0.5" r=".8" /><rect x="18.5" y="-5.5" width="9" height="4.5" rx="2.2" />{dots(-3.25, 20.8)}</>}
  </g>
</g>;

// In profile the magnifier is held out at eye level, seen nearly edge-on; each time the robot turns to a side it leans,
// at random, back to look up or forward to look down, bending at the hip with the legs planted. Facing us the lens sits
// over one eye, which looks huge through it. The robot turns right, front, left, front; a question mark bobs above.
const AIMS = { up: -14, down: 20 } as const;
const aim = () => Math.random() < .5 ? 'up' : 'down';
const ask = <g className="ar-ask"><path d="M10.8 -2.4 A1.3 1.3 0 1 1 12.1 -1.1 V-0.1" /><circle cx="12.1" cy="1.1" r=".3" fill="currentColor" stroke="none" /></g>;
function SearchScene() {
  const [aims, setAims] = useState<[keyof typeof AIMS, keyof typeof AIMS]>(() => [aim(), aim()]);
  // The question mark rides above the head, leaning with it, never mirrored.
  const side = (which: keyof typeof AIMS, mirrored: boolean) => <>{standingLegs}<g transform={`rotate(${AIMS[which]} 12.2 18)`}>{sideHead}{sideBody}
    <g className="ar-scan"><line x1="14.5" y1="13.2" x2="19.8" y2="12.6" /><line x1="19.8" y1="12.6" x2="19.8" y2="9.8" strokeWidth="1.4" />
      <ellipse cx="19.8" cy="7.4" rx="1.3" ry="2.4" strokeWidth="1.1" /></g>
    <g transform={mirrored ? 'translate(24.2 0) scale(-1 1)' : undefined}>{ask}</g></g></>;
  // A new aim for both sides each lap of the turn (child animations bubble here too, hence the name check).
  return <g className="ar-look" onAnimationIteration={event => { if (event.animationName === 'ar-right') setAims([aim(), aim()]); }}>
    <g className="ar-right">{side(aims[0], false)}</g>
    <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{side(aims[1], true)}</g></g>
    {/* Facing us the lens moves to and from the eye, which swells and shrinks behind it. */}
    <g className="ar-front">{antenna}<rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10" cy="7.5" r=".9" />
      <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
      <line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="14" x2="17.5" y2="11.8" /><line x1="17.5" y1="11.8" x2="15.7" y2="9.3" strokeWidth="1.4" />
      <circle className="ar-near" cx="14" cy="7.5" r="2.3" strokeWidth="1.1" /><circle className="ar-near eye" cx="14" cy="7.5" r=".95" fill="currentColor" stroke="none" />{ask}</g>
  </g>;
}

function Scene({ activity, fix }: { activity: Activity; fix: 'hammer' | 'wrench' }) {
  switch (activity) {
    case 'write': return <g transform="translate(-6 0)">
      {/* Sitting on a stool at a desk, typing on a desktop computer turned three-quarters toward it (its near edge, to the right, taller), the screen filling with lines. */}
      {sideHead}{sideBody}<line x1="9" y1="18.6" x2="13.5" y2="18.6" /><line x1="9.6" y1="18.6" x2="9.6" y2="21.5" /><line x1="12.9" y1="18.6" x2="12.9" y2="21.5" />
      <path d="M12.4 18 H15.2 V21.5" /><line className="ar-type" x1="12" y1="13" x2="16.8" y2="14.4" />
      <line x1="15.5" y1="15" x2="26.6" y2="15" /><line x1="16.6" y1="15" x2="16.6" y2="21.5" /><line x1="25.8" y1="15" x2="25.8" y2="21.5" />
      <line x1="16.6" y1="14.6" x2="20.2" y2="14.6" /><rect x="21.4" y="13.8" width="1.4" height=".8" rx=".4" />
      <path d="M20 6.2 L25.6 5 V12.8 L20 11.6 Z" /><path d="M25.6 5 L26.4 5.4 V12.4 L25.6 12.8" /><line x1="23.4" y1="12.4" x2="23.4" y2="15" />
      <rect x="18.4" y="16.4" width="3.4" height="5.1" rx=".4" /><circle cx="20.1" cy="17.6" r=".3" fill="currentColor" stroke="none" />
      <line className="ar-glow" x1="21" y1="7.44" x2="24.4" y2="7.08" /><line className="ar-glow b" x1="21" y1="8.9" x2="23.8" y2="8.9" /><line className="ar-glow c" x1="21" y1="10.36" x2="23.2" y2="10.59" />
    </g>;
    case 'terminal': return <>
      {/* Back to us at a wide screen; each press of the right hand scrolls the output up one line (both loops share 0.8 s steps). */}
      <defs><clipPath id="ar-screen"><rect x="3.6" y="3.1" width="18.8" height="8.8" /></clipPath></defs>
      <rect x="3" y="2.5" width="20" height="10" rx="1" />
      <g clipPath="url(#ar-screen)"><g className="ar-scroll">{[15, 9, 18, 15, 9, 18, 15, 9].map((end, i) => <line key={i} x1="5" y1={5 + i * 2} x2={end + 3} y2={5 + i * 2} />)}</g></g>
      <g transform="translate(-4 0)">{antenna}<rect className="ar-solid" x="7" y="4" width="10" height="7" rx="2" /><rect className="ar-solid" x="8.5" y="12" width="7" height="6" rx="1" />
        <line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line className="ar-tap" x1="17.5" y1="13" x2="19" y2="10.5" />
        <line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></g>
    </>;
    case 'fix': return fix === 'hammer' ? <>
      {/* In profile, hammering a nail into a block; at 14° the hammer's face lands on the nail head, sparks fly. */}
      {sideHead}{sideBody}{standingLegs}<rect x="16.8" y="18.2" width="4.6" height="3.3" rx=".4" /><line x1="19.2" y1="16.8" x2="19.2" y2="18.2" /><line x1="18.4" y1="16.8" x2="20" y2="16.8" />
      <g className="ar-hammer"><line x1="12" y1="13" x2="19.6" y2="13" /><rect x="18.6" y="11" width="2.4" height="4" rx=".4" /></g><g className="ar-spark" strokeWidth=".7"><line x1="17.70" y1="16.75" x2="16.00" y2="16.69" /><line x1="17.88" y1="16.10" x2="16.37" y2="15.30" /><line x1="18.32" y1="15.59" x2="17.32" y2="14.21" /><line x1="20.08" y1="15.59" x2="21.08" y2="14.21" /><line x1="20.52" y1="16.10" x2="22.03" y2="15.30" /><line x1="20.70" y1="16.75" x2="22.40" y2="16.69" /></g>
    </> : <>
      {/* Facing us, turning an open-end wrench on a bolt atop a post; the hand stays on the handle. */}
      {front}<line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="23" y1="15.6" x2="23" y2="21.5" />
      <line x1="17.5" y1="13" x2="20.11" y2="17.72"><animate attributeName="x2" values="20.11;18.72;17.98;18.72;20.11" dur="2.2s" repeatCount="indefinite" /><animate attributeName="y2" values="17.72;16.29;14.44;16.29;17.72" dur="2.2s" repeatCount="indefinite" /></line>
      <g><animateTransform attributeName="transform" type="rotate" values="-25 23 13.5;-2.5 23 13.5;20 23 13.5;-2.5 23 13.5;-25 23 13.5" dur="2.2s" repeatCount="indefinite" />
        <path d="M24 13.5 L23.5 14.37 H22.5 L22 13.5 L22.5 12.63 H23.5 Z" /><line x1="21.28" y1="14.52" x2="18.6" y2="16.1" strokeWidth="1.4" /><path d="M24.89 14.16 A2 2 0 1 1 23.33 11.53" /></g>
    </>;
    case 'search': return <SearchScene />;
    case 'read': {
      // Facing us over an open book held low and tipped toward its face; its right hand turns the right page over to the left.
      // In perspective: the far (top) edge is narrower than the near one, and the page block's edge shows below.
      const outer = (y: number) => 5.6 + 1.4 * (y - 14.4) / 3.8;
      const page = (side: 1 | -1) => <><path d={`M12 14.4 Q${12 + side * 2.8} 13.8 ${12 + side * 5.6} 14.4 L${12 + side * 7} 18.2 Q${12 + side * 3.5} 17.5 12 18.2 Z`} className="ar-solid" />
        {[15.3, 16.3, 17.2].map(y => <line key={y} x1={12 + side * 1.2} y1={y} x2={12 + side * (outer(y) - (y === 17.2 ? 2.4 : .9))} y2={y} strokeWidth=".6" />)}</>;
      const turn = { dur: '2.4s', repeatCount: 'indefinite', keyTimes: '0;.55;.9;1', calcMode: 'spline', keySplines: '0 0 1 1;.42 0 .58 1;0 0 1 1' } as const;
      return <>{antenna}<rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10" cy="8.4" r=".9" /><circle cx="14" cy="8.4" r=".9" />
        <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
        <path d="M5 18.2 V18.9 Q8.5 18.2 12 18.9 Q15.5 18.2 19 18.9 V18.2" />{page(-1)}{page(1)}<g transform="translate(12 0)"><g><animateTransform attributeName="transform" type="scale" values="1 1;1 1;-1 1;-1 1" {...turn} /><g transform="translate(-12 0)">{page(1)}</g></g></g>
        <line x1="15.5" y1="13" x2="17.6" y2="14.4"><animate attributeName="x2" values="17.6;17.6;6.4;6.4" {...turn} /></line></>;
    }
    case 'wait': return pacing(false, true);
    case 'rest': return <>
      {/* On its back on a couch, eyes shut, still; Zzz drift up toward the middle. */}
      <rect x="1" y="10.6" width="24" height="5.4" rx="1.2" /><line x1="2" y1="18" x2="2" y2="21" /><line x1="24" y1="18" x2="24" y2="21" />
      <g><line x1="0.9" y1="11.9" x2="2.4" y2="11.9" /><rect className="ar-solid" x="2.4" y="8.6" width="7" height="6.6" rx="2" /><path d="M5.6 10 Q4.8 10.9 5.6 11.8" />
        <rect className="ar-solid" x="10" y="10.2" width="6.4" height="5" rx="1" /><line x1="11" y1="10.2" x2="15" y2="9.4" /></g>
      <line x1="16.4" y1="13" x2="23" y2="13" /><line x1="16.4" y1="14.3" x2="23" y2="14.3" />
      <rect className="ar-solid" x="0" y="15.4" width="26" height="2.6" rx="1" /><rect className="ar-solid" x="-1" y="13.4" width="2.6" height="4.6" rx="1" /><rect className="ar-solid" x="24.4" y="13.4" width="2.6" height="4.6" rx="1" />
      {[0, 1, 2].map(i => <path key={i} className="ar-z" style={{ animationDelay: `${i * .8}s` }} d="M10.5 6.6 h2.2 l-2.2 2.2 h2.2" strokeWidth=".6" />)}
    </>;
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
