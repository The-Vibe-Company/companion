// @vitest-environment node
import { renderInBrowser } from "../test/browser";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps the conversation usable beside resources on desktop and across mobile views", async () => {
  // Render the actual component with API fixtures. This checks layout and interactions,
  // not backend persistence or live agent execution.
  const directory = mkdtempSync(path.join(process.cwd(), "node_modules/.discussion-browser-"));
  try {
    const entry = path.join(directory, "entry.tsx");
    writeFileSync(entry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DiscussionsWorkspace } from '../../src/components/DiscussionsWorkspace';
      import '../../src/index.css';
      import '../../src/maison.css';
      const now = '2026-09-14T10:00:00Z';
      const ada = { id:'ada', name:'Ada', instructions:'Research and strategy', provider:'local', status:'ready', error:null, createdAt:now, avatar:{shape:1,color:2,face:0} };
      const june = { ...ada, id:'june', name:'June', instructions:'Writing and editing', avatar:{shape:3,color:5,face:2} };
      // A long name widens the create menu enough to test that it stays on screen.
      const long = { ...ada, id:'long', name:'Validation runtime wake (temporary)', instructions:'Temporary validation', avatar:{shape:2,color:4,face:1} };
      const lastMessage = { role:'assistant', companionId:'ada', createdAt:now, preview:'Reviewing the pricing and onboarding flows.' };
      const discussion = { id:'chat', title:'Preparing the autumn launch', folderId:null, directCompanionId:null, archivedAt:null, createdAt:now, updatedAt:now, participantIds:['ada','june'], lastMessage };
      const messages = [
        { id:'1',sequence:'1',role:'user',content:'Help me prepare the launch. We need a clear positioning and a first announcement.',companionId:null,runId:'central',createdAt:now,complete:true,files:[] },
        { id:'2',sequence:'2',role:'assistant',content:'I’ve asked Ada to compare the alternatives and June to draft the announcement.\\n\\nWe’ll bring their findings together here.',companionId:null,runId:'central',createdAt:now,complete:true,files:[] }
      ];
      const task = { previewText:null,resultText:null,error:null,createdAt:now,finishedAt:null,files:[],questions:[] };
      const snapshot = { discussion,participants:[ada,june].map(companion=>({companionId:companion.id,companion,removedAt:null})), messages,
        tasks:[{...task,id:'research',companionId:'ada',status:'running',content:'Compare positioning across three competing products',previewText:'Reviewing the pricing and onboarding flows.'},
          {...task,id:'draft',companionId:'june',status:'needs_input',content:'Draft the launch announcement',questions:[{id:'q',question:'Who is the announcement for?',options:['Existing customers','New customers'],answer:null}]}],
        centralRuns:[],proposals:[],beforeCursor:null };
      window.fetch = async input => new Response(JSON.stringify(String(input)==='/api/discussions' ? {discussions:[discussion],folders:[]} : snapshot), {headers:{'content-type':'application/json'}});
      createRoot(document.getElementById('root')).render(<DiscussionsWorkspace user={{id:'user',name:'Sam',email:'sam@example.invalid'}} companions={[ada,june,long]} initialDiscussionId='chat' legacyCompanionId={null} onUnauthorized={()=>{}} onCreateCompanion={()=>{}} onApplications={()=>{}} onAccount={()=>{}} onCompanionSettings={()=>{}}/>);
      const wait = () => new Promise(resolve=>setTimeout(resolve,40));
      async function check() {
        for (let i=0;i<40&&!document.querySelector('.discussion-composer');i++) await wait();
        const visible = node => !!node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
        document.querySelector('.discussion-wordmark img').src = ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'public/favicon.svg')).href)};
        const timeline = document.querySelector('.discussion-timeline');
        const composer = document.querySelector('.discussion-composer');
        let rail = document.querySelector('.discussion-workbench');
        const field = composer.querySelector('textarea');
        const mobile = innerWidth <= 1024;
        const result = { viewport:innerWidth, mobile, initialThread:visible(timeline), initialComposer:visible(composer), initialActivity:visible(rail), overflow:document.documentElement.scrollWidth>innerWidth, stopWidth:document.querySelector('.quiet-stop').getBoundingClientRect().width };
        const row = [...document.querySelectorAll('.discussion-row')].find(node => node.textContent.includes('Preparing'));
        result.rosterTime = mobile || visible(row.querySelector('time'));
        row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})); await wait();
        result.rowMenu = !!document.querySelector('[role="menu"] [role="menuitem"]');
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); await wait();
        result.rowMenuClosed = !document.querySelector('[role="menu"]');
        const createTrigger = document.querySelector('[aria-label="Create"]').getBoundingClientRect();
        document.querySelector('[aria-label="Create"]').click(); await wait();
        const createBox = document.querySelector('[role="menu"]')?.getBoundingClientRect();
        result.createMenuOnScreen = !!createBox && createBox.left >= 0 && createBox.right <= innerWidth && createBox.top >= 0;
        // Without the clamp this menu would start left of the viewport; prove the fixture is wide enough.
        result.createMenuNeedsClamp = !!createBox && createTrigger.right - createBox.width < 0;
        result.createMenuWidth = createBox ? Math.round(createBox.width) : 0;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); await wait();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        setter.call(field,'one'); field.dispatchEvent(new Event('input',{bubbles:true})); await wait();
        const oneLine = field.getBoundingClientRect().height;
        setter.call(field,['one','two','three','four','five','six'].join(String.fromCharCode(10))); field.dispatchEvent(new Event('input',{bubbles:true})); await wait();
        const sixLines = field.getBoundingClientRect().height;
        result.textareaGrows = sixLines > oneLine * 2 && visible(composer) && composer.getBoundingClientRect().bottom <= innerHeight;
        setter.call(field,'Keep my draft'); field.dispatchEvent(new Event('input',{bubbles:true})); await wait();
        document.querySelector(mobile ? '[aria-label="Show files"]' : '[aria-label="Workspace"]').click(); await wait();
        rail = document.querySelector('.discussion-workbench');
        result.activityVisible = visible(rail) && visible(rail.querySelector('.discussion-resources'));
        result.agentTask = rail.textContent.includes('Companion workspaces');
        rail.querySelector('[aria-label="Ada"]').click(); await wait();
        result.workbenchVisible = visible(document.querySelector('[aria-label="Ada workbench"]'));
        result.taskDetails = rail.textContent.includes('No files yet');
        if (!mobile) {
          const before = rail.getBoundingClientRect().width;
          document.querySelector('[aria-label="Expand workspace"]').click(); await wait();
          result.expands = rail.getBoundingClientRect().width > before && visible(composer) && document.documentElement.scrollWidth <= innerWidth;
        } else result.expands = true;
        document.querySelector('[aria-label="Close workbench"]').click(); await wait();
        result.returnedToThread = visible(timeline) && visible(composer);
        result.draftPreserved = field.value === 'Keep my draft';
        const recipient = document.querySelector('[aria-label="Message recipient"]');
        result.recipientUnchanged = recipient.value === '';
        const box = composer.getBoundingClientRect();
        result.composerOnScreen = box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
        result.noHorizontalOverflow = [timeline,composer,rail].filter(visible).every(node=>node.scrollWidth<=node.clientWidth+1);
        const press = document.querySelector('.composer-send');
        press.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0}));
        await new Promise(resolve=>setTimeout(resolve,180));
        result.pressScale = getComputedStyle(press).scale;
        press.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
        const answerInput = document.querySelector('.discussion-question input').getBoundingClientRect();
        const answerButton = document.querySelector('.discussion-question button[type="submit"]').getBoundingClientRect();
        result.answerFits = answerInput.left >= 0 && answerButton.right <= innerWidth;
        const workspaceButton = document.querySelector('[aria-label="Workspace"]');
        workspaceButton.focus(); workspaceButton.click(); await wait();
        const detailsTab = [...document.querySelectorAll('.workbench-tabs button')].find(node => node.textContent.includes('Details'));
        detailsTab.click(); await wait();
        result.detailsVisible = visible(document.querySelector('.discussion-details-body'));
        result.detailsArchive = !!document.querySelector('.archive-discussion');
        document.querySelector('[aria-label="Close workbench"]').click(); await wait();
        result.returnedToThread = visible(timeline) && visible(composer);
        const report = document.createElement('pre'); report.id='browser-result'; report.hidden=true; report.textContent=JSON.stringify(result); document.body.append(report);
      }
      check().catch(error=>{const report=document.createElement('pre');report.id='browser-result';report.textContent=JSON.stringify({error:String(error)});document.body.append(report);});
    `);
    const bundle = await build({ logLevel: "silent", build: { write: false, rollupOptions: { input: entry, output: { format: "iife", inlineDynamicImports: true } } } });
    const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(bundle => "output" in bundle ? bundle.output : []);
    const css = output.filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css")).map(asset => asset.type === "asset" ? String(asset.source) : "").join("\n");
    const js = output.filter(asset => asset.type === "chunk").map(asset => asset.type === "chunk" ? asset.code : "").join("\n");
    const file = path.join(directory, "index.html");
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script>`);
    for (const [width, reducedMotion] of [[1440, false], [1100, false], [768, false], [390, false], [320, false], [390, true]] as const) {
      const screenshot = process.env.DISCUSSION_SCREENSHOTS;
      if (screenshot) mkdirSync(screenshot, { recursive: true });
      const dom = await renderInBrowser({
        url:pathToFileURL(file).href, profile:path.join(directory, `profile-${width}-${reducedMotion}`), width, reducedMotion, height:width < 500 ? 844 : 900,
        screenshot:screenshot ? path.resolve(screenshot, `discussion-${width}${reducedMotion ? "-reduced" : ""}.png`) : undefined,
      });
      const match = dom.match(/<pre id="browser-result"[^>]*>(.*?)<\/pre>/);
      expect(match, `browser report at ${width}px`).not.toBeNull();
      const result = JSON.parse(match![1]);
      expect(result, `${width}px`).toMatchObject({
        pressScale: reducedMotion ? "1" : "0.96", answerFits: true, viewport: width, mobile: width <= 1024, initialThread: true, initialComposer: true, initialActivity: false, expands: true,
        rosterTime: true, rowMenu: true, rowMenuClosed: true, createMenuOnScreen: true, createMenuNeedsClamp: true, textareaGrows: true,
        overflow: false, activityVisible: true, agentTask: true, workbenchVisible: true, taskDetails: true,
        detailsVisible: true, detailsArchive: true, returnedToThread: true, draftPreserved: true, recipientUnchanged: true, composerOnScreen: true, noHorizontalOverflow: true,
      });
      expect(result.stopWidth).toBeLessThanOrEqual(44);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
