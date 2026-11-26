import { usePreferences } from './use-preferences';
import { usePointerCoarse } from './components/ui/hooks/use-pointer-coarse';
import { usePrefersReducedMotion } from './components/ui/hooks/use-media-query';
import { createContext, useContext, useEffect, useRef, useState, type AnimationEvent, type ReactNode } from 'react';

// A small line-art robot that shows what the agent is doing. Each scene is one CSS loop on a shared figure:
// think — walks, stops facing front with a thought bubble (the default); write — sits at a desktop computer, typing;
// terminal — back to us at a screen of scrolling lines; fix — hammers a nail or turns a wrench on a bolt; search — looks
// around through a magnifier; read — faces us over an open book, turning its pages; wait — walks to and fro, kicking a pebble;
// rest — the turn is over but background work runs: lies on a couch, breathing, Zzz rising; compact — the context is
// being compacted: carries a stack of sheets into a press and squeezes it.
// Reduced motion and disabled animation use a still frame.
export type Activity = 'think' | 'write' | 'terminal' | 'fix' | 'search' | 'read' | 'wait' | 'rest' | 'compact';

// What the open chat's agent is doing now (see useAgentActivity); robots without their own activity follow it.
export const ActivityContext = createContext<Activity>('think');
// The same moment in words, shown beside a live robot (see WorkLog); null outside a chat.
export const ActivityLabelContext = createContext<string | null>(null);

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
.ar-type{transform-box:view-box;transform-origin:12px 13px;animation:ar-type .22s ease-in-out infinite alternate}.ar-type.b{animation-direction:alternate-reverse}
.ar-glow{animation:ar-dot .9s ease-in-out infinite;opacity:.2}.ar-glow.b{animation-delay:.3s}.ar-glow.c{animation-delay:.6s}
.ar-scroll{animation:ar-scroll 2.4s ease-out infinite}
.ar-tap{transform-box:view-box;transform-origin:17.5px 13px;animation:ar-tap .8s ease-in-out infinite}
.ar-hammer{transform-box:view-box;transform-origin:12px 13px;animation:ar-hammer 1.3s infinite}
.ar-look .ar-right,.ar-look .ar-left,.ar-look .ar-front{animation-duration:6s}
.ar-move.ar-quick{animation-name:ar-move-q}.ar-move.ar-quick,.ar-quick .ar-right,.ar-quick .ar-left,.ar-quick .ar-front{animation-duration:13s}.ar-quick .ar-right{animation-name:ar-right-q}.ar-quick .ar-left{animation-name:ar-left-q}.ar-quick .ar-front{animation-name:ar-front-q}.ar-watch{animation:ar-watch 13s step-end infinite;opacity:0}
.ar-nod{transform-box:view-box;transform-origin:12px 11px;animation:ar-nod .25s ease-in-out infinite alternate}
.ar-peek{animation:ar-peek 7s ease-in-out infinite}
.ar-bow{transform-box:view-box;transform-origin:12px 11px;animation:ar-bow 7s ease-in-out infinite}
.ar-idle{transform-box:view-box;transform-origin:6.5px 13px;animation:ar-idle 6s ease-in-out infinite}
.ar-nod.slow{animation-duration:.325s;animation-delay:.374s}
.ar-scratch{transform-box:view-box;transform-origin:16.3px 13px;animation:ar-scratch .55s ease-in-out infinite alternate}
.ar-z{animation:ar-z 2.4s linear infinite;opacity:0}
.ar-near{transform-box:view-box;transform-origin:14px 7.5px;animation:ar-near 1s ease-in-out infinite alternate}.ar-near.eye{animation-name:ar-near-eye}
.ar-spark{transform-box:view-box;transform-origin:19.2px 16.8px;animation:ar-spark 1.3s linear infinite;opacity:0}
.ar-leg.slow,.ar-arm.slow{animation-duration:.65s;animation-delay:.374s}
.ar-down{animation:ar-down 13s ease-in-out infinite}.ar-walking{animation:ar-walking 13s step-end infinite}.ar-kicking{animation:ar-kicking 13s step-end infinite;opacity:0}
.ar-kick{transform-box:fill-box;transform-origin:50% 0;animation:ar-kick 13s ease-in-out infinite}
.ar-pebble{transform:translate(8.5px,20.7px);animation:ar-pebble 13s ease-out infinite}.ar-hop{animation:ar-hop 13s infinite}
.ar-spin{transform-box:fill-box;transform-origin:50% 50%;animation:ar-spin 13s ease-out infinite}
.ar-solid{fill:var(--background,#fff)}
.ar-dancing *{animation-play-state:paused}.ar-dancing .ar-dance *{animation-play-state:running}.ar-dancing .ar-quick>.ar-front{visibility:hidden}
.ar-fore{transform-box:view-box;animation:3s infinite}.ar-fore.l{transform-origin:5px 13.2px;animation-name:ar-fore-l}.ar-fore.r{transform-origin:19px 13.2px;animation-name:ar-fore-r}
.ar-tick{transform-box:view-box;transform-origin:12px 11.5px;animation:ar-tick 1.5s infinite}
.ar-pop{animation:ar-pop .75s step-end infinite}
@keyframes ar-fore-l{0%,25%,50%,75%{animation-timing-function:steps(3,end)}0%{transform:rotate(-90deg)}8%,25%{transform:rotate(0)}33%,50%{transform:rotate(-180deg)}58%,75%{transform:rotate(0)}83%,100%{transform:rotate(-90deg)}}
@keyframes ar-fore-r{0%,25%,50%,75%{animation-timing-function:steps(3,end)}0%{transform:rotate(90deg)}8%,25%{transform:rotate(180deg)}33%,50%{transform:rotate(0)}58%,75%{transform:rotate(0)}83%,100%{transform:rotate(90deg)}}
@keyframes ar-tick{0%,50%{animation-timing-function:steps(2,end)}0%{transform:rotate(7deg)}16%,50%{transform:rotate(-7deg)}66%,100%{transform:rotate(7deg)}}
@keyframes ar-pop{0%{transform:translateY(0)}10%{transform:translateY(.6px)}35%{transform:translateY(0)}}
@keyframes ar-move-q{0%{transform:translateX(-8px)}42%,46%{transform:translateX(8px)}88%,100%{transform:translateX(-8px)}}
@keyframes ar-right-q{0%{opacity:1}42%{opacity:0}}
@keyframes ar-left-q{0%{opacity:0}46%{opacity:1}88%{opacity:0}}
@keyframes ar-front-q{0%{opacity:0}42%{opacity:1}46%{opacity:0}}
@keyframes ar-watch{0%{opacity:0}88%{opacity:1}}
@keyframes ar-nod{from{transform:rotate(6deg)}to{transform:rotate(-1deg)}}
@keyframes ar-bow{0%,26%,38%,77%,86%,100%{transform:rotate(0)}29%,35%,80%,83%{transform:rotate(10deg)}}
@keyframes ar-peek{0%,26%,38%,77%,86%,100%{transform:translate(0,0)}29%,35%,80%,83%{transform:translate(-.2px,.8px)}}
@keyframes ar-idle{0%,55%,85%,100%{transform:rotate(0)}60%{transform:rotate(14deg)}66%{transform:rotate(-9deg)}72%{transform:rotate(10deg)}78%{transform:rotate(-5deg)}}
@keyframes ar-scratch{from{transform:rotate(-10deg)}to{transform:rotate(24deg)}}
@keyframes ar-z{0%{transform:translate(0,0) scale(.7);opacity:0}20%{opacity:1}100%{transform:translate(5px,-9px) scale(1.2);opacity:0}}
@keyframes ar-near{from{transform:scale(1)}to{transform:scale(1.15)}}
@keyframes ar-near-eye{from{transform:scale(1)}to{transform:scale(1.25)}}
@keyframes ar-spark{0%,19%{opacity:0;transform:scale(.4)}21%{opacity:1;transform:scale(1)}36%,100%{opacity:0;transform:scale(1.3)}}
@keyframes ar-down{0%,5.377%{transform:translateY(0)}6.877%,9.877%{transform:translateY(1.1px)}11.377%,50.377%{transform:translateY(0)}51.877%,54.877%{transform:translateY(1.1px)}56.377%,100%{transform:translateY(0)}}
@keyframes ar-walking{0%{opacity:1}5.377%{opacity:0}10.377%{opacity:1}50.377%{opacity:0}55.377%{opacity:1}}
@keyframes ar-kicking{0%{opacity:0}5.377%{opacity:1}10.377%{opacity:0}50.377%{opacity:1}55.377%{opacity:0}}
@keyframes ar-kick{0%,5.377%{transform:rotate(0)}7.877%{transform:rotate(-55deg)}10.377%,50.377%{transform:rotate(0)}52.877%{transform:rotate(-55deg)}55.377%,100%{transform:rotate(0)}}
@keyframes ar-pebble{0%,7.877%{transform:translate(8.5px,20.7px)}12.477%,52.877%{transform:translate(15.5px,20.7px)}57.477%,100%{transform:translate(8.5px,20.7px)}}
@keyframes ar-hop{0%,7.877%{transform:translateY(0);animation-timing-function:ease-out}10.177%{transform:translateY(-2.2px);animation-timing-function:ease-in}12.477%,52.877%{transform:translateY(0);animation-timing-function:ease-out}55.177%{transform:translateY(-2.2px);animation-timing-function:ease-in}57.477%,100%{transform:translateY(0)}}
@keyframes ar-spin{0%,7.877%{transform:rotate(0)}12.477%,52.877%{transform:rotate(360deg)}57.477%,100%{transform:rotate(0)}}
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
.ar-track{animation:ar-track 1.3s infinite}
.ar-lean{transform-box:view-box;transform-origin:12px 18px;animation:ar-lean 1.3s infinite}
.ar-strike{transform-box:view-box;transform-origin:12px 11px;animation:ar-strike 1.3s infinite}
@keyframes ar-track{0%{transform:translate(0,-.6px);animation-timing-function:cubic-bezier(.55,0,1,.6)}20%,45%{transform:translate(0,.9px);animation-timing-function:ease-in-out}100%{transform:translate(0,-.6px)}}
@keyframes ar-lean{0%{transform:rotate(-3deg);animation-timing-function:cubic-bezier(.55,0,1,.6)}20%,45%{transform:rotate(3deg);animation-timing-function:ease-in-out}100%{transform:rotate(-3deg)}}
@keyframes ar-strike{0%,20%{transform:rotate(0);animation-timing-function:ease-out}27%{transform:rotate(7deg);animation-timing-function:ease-in-out}45%,100%{transform:rotate(0)}}
@keyframes ar-hammer{0%{transform:rotate(-15deg);animation-timing-function:cubic-bezier(.55,0,1,.6)}20%,45%{transform:rotate(26.7deg);animation-timing-function:ease-in-out}100%{transform:rotate(-15deg)}}
`;

const antenna = <line x1="12" y1="2.5" x2="12" y2="4" />;
// Profile facing right: head with one eye, body; the scenes add arms, legs and what the robot holds.
const sideHead = <>{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle cx="14" cy="7.5" r=".9" /></>;
const sideBody = <rect x="9.5" y="12" width="5" height="6" rx="1" />;
const standingLegs = <><line x1="12" y1="18" x2="12" y2="21.5" /><line x1="12.4" y1="18" x2="12.4" y2="21.5" /></>;
const eyes = <><circle cx="10" cy="7.5" r=".9" /><circle cx="14" cy="7.5" r=".9" /></>;
const faceless = <>{antenna}<rect x="7" y="4" width="10" height="7" rx="2" />
  <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></>;
const front = <>{faceless}{eyes}</>;
const dots = (y: number, x0: number) => <><circle className="ar-dot" cx={x0} cy={y} r=".3" fill="currentColor" stroke="none" /><circle className="ar-dot b" cx={x0 + 2.2} cy={y} r=".3" fill="currentColor" stroke="none" /><circle className="ar-dot c" cx={x0 + 4.4} cy={y} r=".3" fill="currentColor" stroke="none" /></>;

// Thinking, each walk to a side in one of two moods, picked at random every lap: chin up, rubbing it (the arm raised to
// reach the lifted chin), or hands clasped behind the back, leaning forward from the hip, head bowed, eyes on the floor, nodding with each step.
type Mood = 'chin' | 'behind';
const pickMood = (): Mood => Math.random() < .5 ? 'chin' : 'behind';
const thinker = (mood: Mood) => mood === 'chin'
  ? <><g transform="rotate(-12 12 11)">{sideHead}</g>{sideBody}<line x1="12" y1="12.8" x2="16.3" y2="13" /><line className="ar-scratch" x1="16.3" y1="13" x2="15.8" y2="10.3" /></>
  : <g transform="rotate(8 12 18)"><g transform="rotate(12 12 11)"><g className="ar-nod">{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle cx="14" cy="8.3" r=".9" /></g></g>{sideBody}<path d="M12 13 L11.2 16.2 L7.9 15.5" /><circle cx="7.9" cy="15.5" r=".45" fill="currentColor" stroke="none" /></g>;
function ThinkScene() {
  const [moods, setMoods] = useState<[Mood, Mood]>(() => [pickMood(), pickMood()]);
  // New moods each lap (child animations bubble here too, hence the name check).
  return <g onAnimationIteration={event => { if (event.animationName === 'ar-right') setMoods([pickMood(), pickMood()]); }}>{pacing(true, false, undefined, moods)}</g>;
}

// Walking in profile: legs scissor from one hip while the body bobs; the thinking robot scratches its chin. The wait scene
// walks slower, nodding with each step (ar-quick: 13 s a lap, a quick turn at the right end; at the left end it checks its watch) past a pebble lying on the ground: once
// each way the front foot kicks it (the walking legs swap for a kicking pair for half a second) and it tumbles to where
// the walk back will meet it. Kick times follow from the walk: rightward at 7.877% (x = -5, the pebble at 8.5), leftward
// at 52.877% (x = 5.4, the pebble at 15.5); each walk takes 42% of the lap. Legs and the arm swing together in .65 s
// half-strides phased so the legs pass vertical exactly as each kick window opens and closes (the kicking pair starts and
// ends vertical too), so a kick never cuts a step short.
const walker = (pebble: boolean, mood: Mood = 'chin') => <>
  <g className="ar-bob">{pebble ? <><g className="ar-nod slow">{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle className="ar-down" cx="14" cy="7.5" r=".9" /></g>{sideBody}<line className="ar-arm slow" x1="12" y1="13" x2="12" y2="16.5" /></>
    : thinker(mood)}</g>
  {pebble ? <><g className="ar-walking"><line className="ar-leg slow" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-leg slow b" x1="12" y1="18" x2="12" y2="21.5" /></g>
    <g className="ar-kicking"><line x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-kick" x1="12" y1="18" x2="12" y2="21.5" /></g></>
    : <><line className="ar-leg" x1="12" y1="18" x2="12" y2="21.5" /><line className="ar-leg b" x1="12" y1="18" x2="12" y2="21.5" /></>}
</>;
const pebble = <g className="ar-pebble"><g className="ar-hop"><path className="ar-spin" d="M-1.26 0.28 Q-1.4 -0.63 -0.21 -0.84 Q1.19 -0.91 1.4 -0.07 Q1.47 0.77 0.21 0.84 Q-1.12 0.91 -1.26 0.28 Z" fill="currentColor" stroke="none" /></g></g>;
const pacing = (bubble: boolean, pebble: boolean, extra?: ReactNode, moods?: [Mood, Mood]) => <g className={pebble ? 'ar-move ar-quick' : 'ar-move'}>
  <g className="ar-right">{walker(pebble, moods?.[0])}</g>
  <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{walker(pebble, moods?.[1])}</g></g>
  <g className="ar-front">{front}<line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="13" x2="17.5" y2="16.5" />
    {/* The thought bubble: two rising puffs and a cloud with three pulsing dots. */}
    {bubble && <g strokeWidth=".55"><circle cx="18" cy="2.5" r=".5" /><circle cx="19.5" cy="0.5" r=".8" /><rect x="18.5" y="-5.5" width="9" height="4.5" rx="2.2" />{dots(-3.25, 20.8)}</g>}
  </g>
  {/* Waiting, at the left end it stops facing us, eyes down on the round watch on its raised forearm; at each kick it
      looks down at the pebble (ar-down). */}
  {pebble && <g className="ar-watch">{antenna}<rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10.4" cy="9.1" r=".9" /><circle cx="14.4" cy="9.1" r=".9" />
    <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
    <line x1="6.5" y1="13" x2="6.5" y2="16.5" /><path d="M17.5 13 V15.4 L13.4 13.9" /><circle className="ar-solid" cx="15.45" cy="14.65" r="1.1" strokeWidth=".6" /></g>}
  {extra}
</g>;

// The robot dance, slow and mechanical: happy eyes, the head clicking side to side, the body jolting down on every .75 s
// beat, and the forearms turning at the elbows in 60° servo steps, then holding: left up and right down, the reverse, both
// up, both straight out. They always swing outward, never through the (solid) body.
const dance = <g className="ar-dance"><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
  <g className="ar-pop"><line x1="8.5" y1="13.2" x2="5" y2="13.2" /><line x1="15.5" y1="13.2" x2="19" y2="13.2" />
    <line className="ar-fore l" x1="5" y1="13.2" x2="5" y2="10.6" /><line className="ar-fore r" x1="19" y1="13.2" x2="19" y2="10.6" />
    <rect className="ar-solid" x="8.5" y="12" width="7" height="6" rx="1" />
    <g className="ar-tick">{antenna}<rect className="ar-solid" x="7" y="4" width="10" height="7" rx="2" /><path d="M9.1 8 Q10 6.9 10.9 8" /><path d="M13.1 8 Q14 6.9 14.9 8" /></g></g></g>;
// Now and then (about one lap in four), at the right end where it turns to face us without checking the watch, the
// waiting robot breaks into the robot dance for five seconds while the walk and the pebble hold still. A lap starting
// arms a timer for that moment, which checks the walk's actual phase, so a late timer (a background tab) skips the dance.
const LAP = 13000, DANCE = 5000;
function WaitScene() {
  const root = useRef<SVGGElement>(null), timers = useRef<number[]>([]), [dancing, setDancing] = useState(false);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const lap = (event: AnimationEvent) => {
    if (event.animationName !== 'ar-move-q' || Math.random() >= .25) return;
    timers.current.push(window.setTimeout(() => {
      const time = root.current?.querySelector('.ar-move')?.getAnimations?.()[0]?.currentTime, at = typeof time === 'number' ? time % LAP / LAP : -1;
      if (at < .425 || at > .45) return;
      setDancing(true);
      timers.current.push(window.setTimeout(() => setDancing(false), DANCE));
    }, LAP * .43));
  };
  return <g ref={root} className={dancing ? 'ar-dancing' : undefined} onAnimationIteration={lap}>{pacing(false, true, dancing && dance)}{pebble}</g>;
}

// In profile the arm comes from the shoulder, the far arm showing from behind the back, and the magnifier, seen nearly
// edge-on, is tipped forward so it stays clear of the head; each time the robot turns to a side it leans,
// at random, back to look up or forward to look down, bending at the hip with the legs planted. Facing us the lens sits
// over one eye, which looks huge through it. The robot turns right, front, left, front.
const AIMS = { up: -14, down: 20 } as const;
const aim = () => Math.random() < .5 ? 'up' : 'down';
function SearchScene() {
  const [aims, setAims] = useState<[keyof typeof AIMS, keyof typeof AIMS]>(() => [aim(), aim()]);
  const side = (which: keyof typeof AIMS) => <>{standingLegs}<g transform={`rotate(${AIMS[which]} 12.2 18)`}>
    {/* The body sways back from the hip as the lens goes out, and forward as it comes back. */}
    <g><animateTransform attributeName="transform" type="rotate" values="0 12.2 18;-3 12.2 18;0 12.2 18" dur="1.6s" repeatCount="indefinite" />{sideHead}{sideBody}
    <line x1="9.5" y1="13.4" x2="8.3" y2="16.3" />
    {/* The lens stands upright like the face, pushed out and drawn back by an arm bent at the elbow (SMIL keeps hand and lens together). */}
    <line x1="12" y1="13" x2="14.58" y2="15.05"><animate attributeName="x2" values="14.58;14.76;14.94;15.12;15.28;15.12;14.94;14.76;14.58" dur="1.6s" repeatCount="indefinite" /><animate attributeName="y2" values="15.05;14.81;14.50;14.08;13.37;14.08;14.50;14.81;15.05" dur="1.6s" repeatCount="indefinite" /></line><line x1="14.58" y1="15.05" x2="16.40" y2="12.30"><animate attributeName="x1" values="14.58;14.76;14.94;15.12;15.28;15.12;14.94;14.76;14.58" dur="1.6s" repeatCount="indefinite" /><animate attributeName="y1" values="15.05;14.81;14.50;14.08;13.37;14.08;14.50;14.81;15.05" dur="1.6s" repeatCount="indefinite" /><animate attributeName="x2" values="16.40;16.90;17.40;17.90;18.40;17.90;17.40;16.90;16.40" dur="1.6s" repeatCount="indefinite" /><animate attributeName="y2" values="12.30;12.30;12.30;12.30;12.30;12.30;12.30;12.30;12.30" dur="1.6s" repeatCount="indefinite" /></line><g><animateTransform attributeName="transform" type="translate" values="0 0;0.5 0;1 0;1.5 0;2 0;1.5 0;1 0;0.5 0;0 0" dur="1.6s" repeatCount="indefinite" /><line x1="16.4" y1="12.3" x2="17.6" y2="9.9" strokeWidth="1.4" /><ellipse cx="17.6" cy="7.5" rx="1.3" ry="2.4" strokeWidth="1.1" /></g>
    </g></g></>;
  // A new aim for both sides each lap of the turn (child animations bubble here too, hence the name check).
  return <g className="ar-look" onAnimationIteration={event => { if (event.animationName === 'ar-right') setAims([aim(), aim()]); }}>
    <g className="ar-right">{side(aims[0])}</g>
    <g className="ar-left"><g transform="translate(24 0) scale(-1 1)">{side(aims[1])}</g></g>
    {/* Facing us the lens moves to and from the eye, which swells and shrinks behind it. */}
    <g className="ar-front">{antenna}<rect x="7" y="4" width="10" height="7" rx="2" /><circle cx="10" cy="7.5" r=".9" />
      <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
      <line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="17.5" y1="14" x2="17.5" y2="11.8" /><line x1="17.5" y1="11.8" x2="15.7" y2="9.3" strokeWidth="1.4" />
      <circle className="ar-near" cx="14" cy="7.5" r="2.3" strokeWidth="1.1" /><circle className="ar-near eye" cx="14" cy="7.5" r=".95" fill="currentColor" stroke="none" /></g>
  </g>;
}

// Compacting, one 8 s lap, standing well clear of the press: the robot, facing left, bends to a stack of sheets and
// lifts it; turns through a front view to face right; sets the stack on the press bed and shoves it, so it slides on
// under the plate; takes the long lever, one hand on top of its grip and one below, and pulls the plate down, leaning in
// with its eyes on the press, while the sheets squeeze into a thin block; the plate rises, the block fades, a new stack
// appears behind it, and it turns back through a rear view to take it. Poses are solved once (arms by two-segment IK from
// the leaning shoulder) and sampled into SMIL keyframes on one clock, so the arms, body, stack and plate never drift apart.
type Key = number[];
const track = (keys: Key[]) => (t: number) => {
  let i = 0; while (i < keys.length - 2 && t >= keys[i + 1]![0]!) i++;
  const k0 = keys[i]!, k1 = keys[i + 1]!, u = Math.min(1, Math.max(0, (t - k0[0]!) / (k1[0]! - k0[0]! || 1))), e = u * u * (3 - 2 * u);
  return k0.slice(1).map((v, j) => v + (k1[j + 1]! - v) * e);
};
type View = 'L' | 'F' | 'R' | 'B';
// The front and rear views are a single 0.03 s in-between frame of each turn.
const VIEWS: [number, View][] = [[0, 'L'], [.18, 'F'], [.18375, 'R'], [.87, 'B'], [.87375, 'L']];
const SHEET = 4.5, GRIP = 2.4, L1 = 2.7, L2 = 3.5, PLATE_Y = 12.8, LEVER_X = 18.2;
let compactKeys: ReturnType<typeof solveCompact> | undefined;
function solveCompact() {
  const view = (t: number) => VIEWS.filter(([at]) => t >= at).at(-1)![1];
  const lean = track([[0, 35], [.07, 35], [.16, 0], [.2, 0], [.27, 12], [.33, 12], [.4, 0], [.45, 8], [.5, 14], [.6, 28], [.66, 28], [.74, 4], [.78, 0], [.89, 0], [1, 35]]);
  const eye = track([[0, .6], [.07, .6], [.16, 0], [.2, 0], [.27, .6], [.33, .4], [.4, 0], [.45, 0], [.6, .7], [.66, .7], [.74, 0], [.89, 0], [1, .6]]);
  const plate = track([[0, 0], [.45, 0], [.5, 1.5], [.6, 4.05], [.66, 4.05], [.74, 0], [1, 0]]), slide = track([[.33, 16.9], [.4, 21]]);
  const squeeze = track([[0, 0], [.5, 0], [.6, 1], [.78, 1], [.8, 0], [1, 0]]), shown = track([[0, 1], [.72, 1], [.78, 0], [.82, 0], [.9, 1], [1, 1]]);
  // The near hand as if facing right (mirrored when facing left).
  const reach = track([[0, 18.2, 18.6], [.07, 18.2, 18.6], [.16, 16.2, 16.2], [.2, 16.2, 16.2], [.27, 15.6, 17.3], [.33, 16.9, 17.3], [.4, 12.6, 19.1], [.45, LEVER_X, PLATE_Y - .1], [.74, LEVER_X, PLATE_Y - .1], [.78, 12.6, 19.1], [.89, 12.6, 19.1], [1, 18.2, 18.6]]);
  // The far hand holds the stack beside the near one, and the lever grip below it.
  const farOffset = track([[0, -.5, .35], [.4, -.5, .35], [.45, 0, 1.1], [.74, 0, 1.1], [.78, -.5, .35], [1, -.5, .35]]);
  const times = [...new Set([...Array.from({ length: 81 }, (_, i) => i / 80), ...VIEWS.slice(1).flatMap(([at]) => [at - 1e-4, at])].map(t => +t.toFixed(4)))].sort((a, b) => a - b);
  const ik = (sx: number, sy: number, hx: number, hy: number, out: number) => {
    const dx = hx - sx, dy = hy - sy, d0 = Math.hypot(dx, dy) || 1, d = Math.min(L1 + L2 - .01, Math.max(Math.abs(L1 - L2) + .01, d0)), ux = dx / d0, uy = dy / d0;
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a)), px = sx + a * ux, py = sy + a * uy;
    const e1 = [px - h * uy, py + h * ux], e2 = [px + h * uy, py - h * ux];
    // Profile elbows hang down; front and rear elbows bend outward (out = -1 left, 1 right).
    const [ex, ey] = out ? (Math.sign(e1[0]! - sx) === out ? e1 : e2) : e1[1]! > e2[1]! ? e1 : e2;
    return { sx, sy, ex: ex!, ey: ey!, hx: sx + ux * d, hy: sy + uy * d };
  };
  const rows = times.map(t => {
    const v = view(t), th = lean(t)[0]! * Math.PI / 180, side = v === 'L' ? -1 : 1;
    const x = (local: number) => v === 'L' ? 24 - local : local;
    const lever = t >= .45 && t <= .74, [lx, ly] = lever ? [LEVER_X, PLATE_Y - .1 + plate(t)[0]!] : reach(t), [ox, oy] = farOffset(t);
    const sxl = 12.2 - .2 * Math.cos(th) + 5 * Math.sin(th), sy = 18 - .2 * Math.sin(th) - 5 * Math.cos(th);
    let near, far, stack: number[];
    if (v === 'F' || v === 'B') {
      // Facing us it holds the stack in front; from behind, empty-handed, its arms hang straight at its sides as in the other scenes.
      const hang = (x: number) => ({ sx: x, sy: 13, ex: x, ey: 14.75, hx: x, hy: 16.5 });
      near = v === 'F' ? ik(17, 13, 14.25, 16.2, 1) : hang(17.5); far = v === 'F' ? ik(7, 13, 9.75, 16.2, -1) : hang(6.5);
      stack = v === 'F' ? [9.75, 18.6] : [1.3, 21];
    } else {
      near = ik(x(sxl), sy, x(lx!), ly!, 0); far = ik(x(sxl), sy, near.hx + ox! * side, near.hy + oy!, 0);
      stack = t < .33 ? [side > 0 ? near.hx : near.hx - SHEET, near.hy + GRIP] : t < .8 ? [slide(t)[0]!, 19.7] : [1.3, 21];
    }
    return { near, far, stack, th: th * 180 / Math.PI, eye: eye(t)[0]!, plate: plate(t)[0]!, squeeze: squeeze(t)[0]!, shown: shown(t)[0]! };
  });
  type Row = typeof rows[number];
  const list = (f: (r: Row) => number | string) => rows.map(r => { const v = f(r); return typeof v === 'number' ? v.toFixed(2) : v; }).join(';');
  const arm = (which: 'near' | 'far') => (['sx', 'sy', 'ex', 'ey', 'hx', 'hy'] as const).reduce((o, k) => ({ ...o, [k]: list(r => r[which][k]) }), {} as Record<'sx' | 'sy' | 'ex' | 'ey' | 'hx' | 'hy', string>);
  return { times: times.join(';'), near: arm('near'), far: arm('far'), lean: list(r => `${r.th.toFixed(1)} 12.2 18`), eye: list(r => 7.5 + r.eye),
    stack: list(r => `${r.stack[0]!.toFixed(2)} ${r.stack[1]!.toFixed(2)}`), plate: list(r => `0 ${r.plate.toFixed(2)}`), shown: list(r => r.shown),
    sheets: [1, 2, 3].map(i => list(r => `0 ${(r.squeeze * i * .85).toFixed(2)}`)) };
}
function CompactScene() {
  const k = compactKeys ??= solveCompact(), clock = { keyTimes: k.times, dur: '8s', repeatCount: 'indefinite' } as const;
  const anim = (attributeName: string, values: string) => <animate attributeName={attributeName} values={values} {...clock} />;
  const move = (type: 'translate' | 'rotate', values: string) => <animateTransform attributeName="transform" type={type} values={values} {...clock} />;
  const arm = (a: typeof k.near) => <><line>{anim('x1', a.sx)}{anim('y1', a.sy)}{anim('x2', a.ex)}{anim('y2', a.ey)}</line><line>{anim('x1', a.ex)}{anim('y1', a.ey)}{anim('x2', a.hx)}{anim('y2', a.hy)}</line></>;
  const profile = <>{standingLegs}<g>{move('rotate', k.lean)}{antenna}<rect className="ar-solid" x="8" y="4" width="8" height="7" rx="2" /><circle cx="14" cy="7.5" r=".9">{anim('cy', k.eye)}</circle><rect className="ar-solid" x="9.5" y="12" width="5" height="6" rx="1" /></g></>;
  const square = (face: boolean) => <>{antenna}<rect className="ar-solid" x="7" y="4" width="10" height="7" rx="2" />{face && eyes}<rect className="ar-solid" x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></>;
  const shown = (view: View, body: ReactNode) => <g><animate attributeName="opacity" keyTimes={VIEWS.map(([at]) => at).join(';')} values={VIEWS.map(([, v]) => v === view ? 1 : 0).join(';')} calcMode="discrete" dur="8s" repeatCount="indefinite" />{body}</g>;
  return <>
    <rect x="15.2" y="20.4" width="12.7" height="1.1" rx=".3" /><line x1="27.2" y1="20.4" x2="27.2" y2="10.5" />
    <g>{move('translate', k.plate)}<rect className="ar-solid" x="20.4" y={PLATE_Y} width="5.8" height=".9" rx=".2" /><line x1="26.2" y1={PLATE_Y + .45} x2="27.2" y2={PLATE_Y + .45} /><path d={`M20.4 ${PLATE_Y + .45} H${LEVER_X} M${LEVER_X} ${PLATE_Y - .45} V${PLATE_Y + 1.35}`} /></g>
    {arm(k.far)}
    {shown('R', profile)}{shown('L', <g transform="translate(24 0) scale(-1 1)">{profile}</g>)}{shown('F', square(true))}{shown('B', square(false))}
    <g>{anim('opacity', k.shown)}{move('translate', k.stack)}{[0, 1, 2, 3].map(i => <line key={i} x1="0" y1={-i * 1.2} x2={SHEET - (i % 2) * .4} y2={-i * 1.2}>{i > 0 && move('translate', k.sheets[i - 1]!)}</line>)}</g>
    {arm(k.near)}
  </>;
}

function Scene({ activity, fix }: { activity: Activity; fix: 'hammer' | 'wrench' }) {
  switch (activity) {
    case 'write': return <g transform="translate(-6 0)">
      {/* Sitting on a stool at a desk, typing on a desktop computer turned three-quarters toward it (its near edge, to the right, taller), the screen filling with lines. */}
      {/* The far arm reaches the keys from behind the (solid) body and taps out of step with the near one; now and then it bows its head and glances down at the keyboard. */}
      <line className="ar-type b" x1="12" y1="13.4" x2="17.8" y2="14.3" /><g className="ar-bow">{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle className="ar-peek" cx="14" cy="7.5" r=".9" /></g><rect className="ar-solid" x="9.5" y="12" width="5" height="6" rx="1" /><line x1="9" y1="18.6" x2="13.5" y2="18.6" /><line x1="9.6" y1="18.6" x2="9.6" y2="21.5" /><line x1="12.9" y1="18.6" x2="12.9" y2="21.5" />
      <path d="M12.4 18 H15.2 V21.5" /><line className="ar-type" x1="12" y1="13" x2="16.8" y2="14.4" />
      <line x1="15.5" y1="15" x2="26.6" y2="15" /><line x1="16.6" y1="15" x2="16.6" y2="21.5" /><line x1="25.8" y1="15" x2="25.8" y2="21.5" />
      <line x1="16.6" y1="14.6" x2="20.2" y2="14.6" />
      <path d="M20 6.2 L25.6 5 V12.8 L20 11.6 Z" /><path d="M25.6 5 L26.4 5.4 V12.4 L25.6 12.8" /><line x1="23.2" y1="12.3" x2="23.2" y2="14.4" /><ellipse cx="23.2" cy="14.5" rx="1.5" ry=".4" fill="currentColor" stroke="none" />
      <rect x="21.5" y="16.4" width="3.4" height="5.1" rx=".4" /><circle cx="23.2" cy="17.6" r=".3" fill="currentColor" stroke="none" />
      <line className="ar-glow" x1="21" y1="7.44" x2="24.4" y2="7.08" /><line className="ar-glow b" x1="21" y1="8.9" x2="23.8" y2="8.9" /><line className="ar-glow c" x1="21" y1="10.36" x2="23.2" y2="10.59" />
    </g>;
    case 'terminal': return <>
      {/* Back to us at a wide screen; each press of the right hand scrolls the output up one line (both loops share 0.8 s steps); now and then the free left arm swings idly. */}
      <defs><clipPath id="ar-screen"><rect x="3.6" y="3.1" width="18.8" height="8.8" /></clipPath></defs>
      <rect x="3" y="2.5" width="20" height="10" rx="1" />
      <g clipPath="url(#ar-screen)"><g className="ar-scroll">{[15, 9, 18, 15, 9, 18, 15, 9].map((end, i) => <line key={i} x1="5" y1={5 + i * 2} x2={end + 3} y2={5 + i * 2} />)}</g></g>
      <g transform="translate(-4 0)">{antenna}<rect className="ar-solid" x="7" y="4" width="10" height="7" rx="2" /><rect className="ar-solid" x="8.5" y="12" width="7" height="6" rx="1" />
        <line className="ar-idle" x1="6.5" y1="13" x2="6.5" y2="16.5" /><line className="ar-tap" x1="17.5" y1="13" x2="19" y2="10.5" />
        <line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" /></g>
    </>;
    case 'fix': return fix === 'hammer' ? <>
      {/* In profile, hammering a nail into a block (a nearly straight arm, the thinner handle rising from the fist at 35°, the head across it); the head's face lands on the nail head, sparks fly. The robot leans back on the swing and forward on the blow (the hammer angle
          makes up for the lean, so the face still lands on the nail), its head jolting forward on impact and its eye following the hammer. */}
      {standingLegs}<rect x="17.5" y="18.2" width="4.6" height="3.3" rx=".4" /><line x1="19.9" y1="16.8" x2="19.9" y2="18.2" /><line x1="19.1" y1="16.8" x2="20.7" y2="16.8" />
      <g className="ar-lean"><g className="ar-strike">{antenna}<rect x="8" y="4" width="8" height="7" rx="2" /><circle className="ar-track" cx="14" cy="7.5" r=".9" /></g>{sideBody}<g className="ar-hammer"><path d="M12 13 Q14 13.6 16 13.4" /><line x1="16" y1="13.4" x2="18.62" y2="11.56" strokeWidth=".7" /><rect x="-1.2" y="-2" width="2.4" height="4" rx=".4" transform="translate(19.6 10.87) rotate(-35)" /></g></g><g transform="translate(.7 0)"><g className="ar-spark" strokeWidth=".7"><line x1="17.70" y1="16.75" x2="16.00" y2="16.69" /><line x1="17.88" y1="16.10" x2="16.37" y2="15.30" /><line x1="18.32" y1="15.59" x2="17.32" y2="14.21" /><line x1="20.08" y1="15.59" x2="21.08" y2="14.21" /><line x1="20.52" y1="16.10" x2="22.03" y2="15.30" /><line x1="20.70" y1="16.75" x2="22.40" y2="16.69" /></g></g>
    </> : <>
      {/* Facing us, turning an open-end wrench on a bolt atop a post; the hand stays on the handle, the arm bending at the elbow (fixed-length segments, solved per keyframe); the eyes, turned to the wrench, rise and fall with its handle. */}
      {faceless}<g><animateTransform attributeName="transform" type="translate" values="1.1 .95;1.1 .45;1.1 .95" dur="2.2s" repeatCount="indefinite" />{eyes}</g><line x1="6.5" y1="13" x2="6.5" y2="16.5" /><line x1="21.8" y1="14.8" x2="21.8" y2="21.5" />
      <line x1="17.5" y1="13" x2="18.88" y2="14.72"><animate attributeName="x2" values="18.88;19.23;19.32;19.24;18.56;19.24;19.32;19.23;18.88" dur="2.2s" repeatCount="indefinite" /><animate attributeName="y2" values="14.72;14.36;14.23;14.35;14.93;14.35;14.23;14.36;14.72" dur="2.2s" repeatCount="indefinite" /></line><line x1="18.88" y1="14.72" x2="18.91" y2="16.92"><animate attributeName="x1" values="18.88;19.23;19.32;19.24;18.56;19.24;19.32;19.23;18.88" dur="2.2s" repeatCount="indefinite" /><animate attributeName="y1" values="14.72;14.36;14.23;14.35;14.93;14.35;14.23;14.36;14.72" dur="2.2s" repeatCount="indefinite" /><animate attributeName="x2" values="18.91;18.14;17.52;17.06;16.78;17.06;17.52;18.14;18.91" dur="2.2s" repeatCount="indefinite" /><animate attributeName="y2" values="16.92;16.27;15.49;14.60;13.64;14.60;15.49;16.27;16.92" dur="2.2s" repeatCount="indefinite" /></line>
      <g transform="translate(-1.2 -0.8)"><g><animateTransform attributeName="transform" type="rotate" values="-25 23 13.5;-13.75 23 13.5;-2.5 23 13.5;8.75 23 13.5;20 23 13.5;8.75 23 13.5;-2.5 23 13.5;-13.75 23 13.5;-25 23 13.5" dur="2.2s" repeatCount="indefinite" />
        <path d="M24 13.5 L23.5 14.37 H22.5 L22 13.5 L22.5 12.63 H23.5 Z" /><line x1="21.28" y1="14.52" x2="18.6" y2="16.1" strokeWidth="1.4" /><path d="M24.89 14.16 A2 2 0 1 1 23.33 11.53" /></g></g>

    </>;
    case 'search': return <SearchScene />;
    case 'read': {
      // Facing us over an open book held low and tipped toward its face; its right hand turns the right page over to the left.
      // In perspective: the far (top) edge is narrower than the near one, the lines arch like the pages, and the page block's edge shows below.
      const outer = (y: number) => 5.6 + 1.4 * (y - 14.4) / 3.8;
      const page = (side: 1 | -1) => <><path d={`M12 14.4 Q${12 + side * 2.8} 13.8 ${12 + side * 5.6} 14.4 L${12 + side * 7} 18.2 Q${12 + side * 3.5} 17.5 12 18.2 Z`} className="ar-solid" />
        {[15.5, 16.9].map(y => { const end = outer(y) - .9; return <path key={y} d={`M${12 + side * 1.2} ${y} Q${12 + side * (1.2 + end) / 2} ${y - .12 * (end - 1.2)} ${12 + side * end} ${y}`} strokeWidth=".6" />; })}</>;
      const turn = { dur: '2.4s', repeatCount: 'indefinite', keyTimes: '0;.55;.9;1', calcMode: 'spline', keySplines: '0 0 1 1;.42 0 .58 1;0 0 1 1' } as const;
      return <>{antenna}<rect x="7" y="4" width="10" height="7" rx="2" />
        {/* The eyes read across the spread, then follow the turning page back to the left. */}
        <g><animateTransform attributeName="transform" type="translate" values="-.6 0;.6 0;-.6 0;-.6 0" dur="2.4s" repeatCount="indefinite" keyTimes="0;.55;.9;1" calcMode="spline" keySplines=".42 0 .58 1;.42 0 .58 1;0 0 1 1" /><circle cx="10" cy="8.4" r=".9" /><circle cx="14" cy="8.4" r=".9" /></g>
        <rect x="8.5" y="12" width="7" height="6" rx="1" /><line x1="10.5" y1="18" x2="10.5" y2="21.5" /><line x1="13.5" y1="18" x2="13.5" y2="21.5" />
        <path d="M5 18.2 V18.9 Q8.5 18.2 12 18.9 Q15.5 18.2 19 18.9 V18.2" />{page(-1)}{page(1)}<g transform="translate(12 0)"><g><animateTransform attributeName="transform" type="scale" values="1 1;1 1;-1 1;-1 1" {...turn} /><g transform="translate(-12 0)">{page(1)}</g></g></g>
        <line x1="15.5" y1="13" x2="17.6" y2="14.4"><animate attributeName="x2" values="17.6;17.6;6.4;6.4" {...turn} /></line></>;
    }
    case 'wait': return <WaitScene />;
    case 'compact': return <CompactScene />;
    case 'rest': return <>
      {/* On its back on a couch, eyes shut, still; Zzz drift up toward the middle. */}
      <rect x="1" y="10.6" width="24" height="5.4" rx="1.2" /><line x1="2" y1="18" x2="2" y2="21" /><line x1="24" y1="18" x2="24" y2="21" />
      <g><line x1="0.9" y1="11.9" x2="2.4" y2="11.9" /><rect className="ar-solid" x="2.4" y="8.6" width="7" height="6.6" rx="2" /><path d="M5.6 10 Q4.8 10.9 5.6 11.8" />
        <rect className="ar-solid" x="10" y="10.2" width="6.4" height="5" rx="1" /><line x1="11" y1="10.2" x2="15" y2="9.4" /></g>
      <line x1="16.4" y1="13" x2="23" y2="13" /><line x1="16.4" y1="14.3" x2="23" y2="14.3" />
      <rect className="ar-solid" x="0" y="15.4" width="26" height="2.6" rx="1" /><rect className="ar-solid" x="-1" y="13.4" width="2.6" height="4.6" rx="1" /><rect className="ar-solid" x="24.4" y="13.4" width="2.6" height="4.6" rx="1" />
      {[0, 1, 2].map(i => <path key={i} className="ar-z" style={{ animationDelay: `${i * .8}s` }} d="M10.5 6.6 h2.2 l-2.2 2.2 h2.2" strokeWidth=".6" />)}
    </>;
    default: return <ThinkScene />;
  }
}

export function RobotLoader({ className = 'h-5', label = 'Still working', activity }: { className?: string; label?: string; activity?: Activity }) {
  const mode = usePreferences().data?.workingAnimation ?? 'desktop', coarse = usePointerCoarse(), reduced = usePrefersReducedMotion();
  const animated = !reduced && mode !== 'off' && (mode !== 'desktop' || !coarse);
  const current = useContext(ActivityContext), shown = activity ?? current;
  // The fix scene picks its tool once per robot, at random.
  const [fix] = useState<'hammer' | 'wrench'>(() => Math.random() < .5 ? 'hammer' : 'wrench');
  return <span role="img" aria-label={label} data-activity={shown} data-animated={animated} className="inline-flex items-center">
    <svg aria-hidden viewBox="-10 -6 44 28" className={`w-auto overflow-visible ${className}`} fill="none" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" strokeLinejoin="round">
      {animated ? <><style>{css}</style><Scene activity={shown} fix={fix} /></> : <g>{front}</g>}
    </svg></span>;
}
