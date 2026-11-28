// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent} from '@testing-library/react';
import {renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {ConversationOutline} from './conversation-outline';
afterEach(cleanup);
it('loads the owner outline only when opened and jumps to its message sequence', async () => {
  const conversationOutline=vi.fn(async()=>({items:[{id:'thr_example:user-seed:5',role:'user',preview:'First question'},{id:'thr_example:user-seed:9',role:'user',preview:'Next question'}],maxSeq:9})), onJump=vi.fn();
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump},{sdk:{threads:{conversationOutline}}} as any);
  expect(conversationOutline).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  fireEvent.click(await slot.findByRole('button',{name:'First question'}));
  expect(onJump).toHaveBeenCalledWith(5);
  expect(slot.queryByRole('dialog')).toBeNull();
});
it('shows each entry as one plain line and names another agent as the sender', async () => {
  const conversationOutline=vi.fn(async()=>({items:[{id:'thr_example:user-seed:2',role:'user',preview:'# **Plan** for the week\nmore'},{id:'thr_example:user-seed:3',role:'user',preview:'> quoted\n\nmy reply'},{id:'thr_example:user-seed:4',role:'user',preview:'[bb message from thread:thr_sender] Review done'},{id:'thr_example:user-seed:6',role:'user',preview:'[bb system]\n\n@thread:thr_sender completed:'}],maxSeq:4}));
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump:()=>{}},{sdk:{threads:{conversationOutline}},sidebarThreads:{threads:[{id:'thr_sender',title:'Manager'}],projects:[]}} as any);
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  for (const name of ['Plan for the week','my reply','Manager: Review done','bb: Manager completed:']) expect(await slot.findByRole('button',{name})).toBeTruthy();
});
it('names the outline button in a hover tooltip', () => {
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump:()=>{}},{sdk:{threads:{conversationOutline:vi.fn()}}} as any);
  expect(slot.getByRole('button',{name:'Thread table of contents'}).getAttribute('title')).toBe('Table of contents');
});
it('lists the newest message first, one line per entry that opens in full on hover or focus, and closes on Escape', async () => {
  const long='A long question that runs well past one line of the list, so it is cut';
  const conversationOutline=vi.fn(async()=>({items:[{id:'thr_example:user-seed:2',role:'user',preview:'Old one'},{id:'thr_example:user-seed:5',role:'user',preview:long}],maxSeq:5})), onJump=vi.fn();
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump},{sdk:{threads:{conversationOutline}}} as any);
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  await slot.findByRole('button',{name:long});
  const list=slot.getByRole('dialog'), entries=list.querySelectorAll('button');
  expect(Array.from(entries).map(b=>b.textContent)).toEqual([long,'Old one']);
  expect(entries[0]!.className).toContain('truncate'); expect(entries[0]!.getAttribute('title')).toBe(long);
  // jsdom does not apply :hover styles, so the classes are the contract.
  expect(entries[0]!.className.split(' ')).toEqual(expect.arrayContaining(['hover:whitespace-normal','focus-visible:whitespace-normal']));
  fireEvent.keyDown(list,{key:'Escape'});
  expect(slot.queryByRole('dialog')).toBeNull();
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  fireEvent.click(await slot.findByRole('button',{name:long}));
  expect(onJump).toHaveBeenCalledWith(5);
});
it('closes on Escape with focus still on the button, and keeps the list inside the viewport as it resizes', async () => {
  const conversationOutline=vi.fn(async()=>({items:[],maxSeq:0}));
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump:()=>{}},{sdk:{threads:{conversationOutline}}} as any);
  const button=slot.getByRole('button',{name:'Thread table of contents'}), box=button.parentElement as HTMLElement;
  let right=1000; box.getBoundingClientRect=()=>({right,left:right-30,top:0,bottom:30,width:30,height:30,x:right-30,y:0,toJSON:()=>({})});
  const size=(w:number)=>{Object.defineProperty(window,'innerWidth',{configurable:true,value:w}); fireEvent(window,new Event('resize'));};
  size(1200); fireEvent.click(button);
  const list=slot.getByRole('dialog');
  // Wide window: 288 px wide, right-aligned to the button.
  expect([list.style.width,list.style.left]).toEqual(['288px','712px']);
  // A button near the left edge: the list shifts right to stay on screen.
  right=120; size(1200); expect(list.style.left).toBe('8px');
  // A short landscape window: the list ends above the bottom edge, so its last entries scroll into view.
  const tall=(h:number)=>Object.defineProperty(window,'innerHeight',{configurable:true,value:h});
  tall(1000); size(1200); expect([list.style.top,list.style.maxHeight]).toEqual(['34px','288px']);
  tall(150); size(1200); expect([list.style.top,list.style.maxHeight]).toEqual(['34px','108px']);
  // A button low in a short window: the list opens above it, within the space there.
  let bottom=230; box.getBoundingClientRect=()=>({right,left:right-30,top:bottom-30,bottom,width:30,height:30,x:right-30,y:bottom-30,toJSON:()=>({})});
  tall(300); size(1200); expect([list.style.top,list.style.bottom,list.style.maxHeight]).toEqual(['','104px','188px']);
  tall(1000); bottom=30;
  // A phone-width window after rotation: the list narrows to the viewport.
  right=360; size(375); expect([list.style.width,list.style.left]).toEqual(['288px','72px']);
  button.focus(); fireEvent.keyDown(button,{key:'Escape'});
  expect(slot.queryByRole('dialog')).toBeNull();
});
