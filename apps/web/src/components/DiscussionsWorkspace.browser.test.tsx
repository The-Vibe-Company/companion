// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps the conversation usable beside activity on desktop and across mobile views", async () => {
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
      const discussion = { id:'chat', title:'Preparing the autumn launch', folderId:null, directCompanionId:null, archivedAt:null, createdAt:now, updatedAt:now, participantIds:['ada','june'] };
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
      createRoot(document.getElementById('root')).render(<DiscussionsWorkspace user={{id:'user',name:'Sam',email:'sam@example.invalid'}} companions={[ada,june]} initialDiscussionId='chat' legacyCompanionId={null} onUnauthorized={()=>{}} onCreateCompanion={()=>{}} onApplications={()=>{}} onAccount={()=>{}}/>);
      const wait = () => new Promise(resolve=>setTimeout(resolve,40));
      async function check() {
        for (let i=0;i<40&&!document.querySelector('.discussion-composer');i++) await wait();
        const visible = node => !!node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
        document.querySelector('.discussion-wordmark img').src = ${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'public/favicon.svg')).href)};
        const timeline = document.querySelector('.discussion-timeline');
        const composer = document.querySelector('.discussion-composer');
        const rail = document.querySelector('.discussion-workbench');
        const field = composer.querySelector('textarea');
        const mobile = innerWidth <= 1024;
        const result = { mobile, initialThread:visible(timeline), initialComposer:visible(composer), initialActivity:visible(rail), overflow:document.documentElement.scrollWidth>innerWidth, stopWidth:document.querySelector('.quiet-stop').getBoundingClientRect().width };
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        setter.call(field,'Keep my draft'); field.dispatchEvent(new Event('input',{bubbles:true})); await wait();
        if (mobile) { document.querySelector('[aria-label="Show activity"]').click(); await wait(); }
        result.activityVisible = visible(rail) && visible(rail.querySelector('.discussion-activity'));
        result.agentTask = rail.textContent.includes('Reviewing the pricing and onboarding flows.');
        rail.querySelector('[aria-label="Ada"]').click(); await wait();
        result.workbenchVisible = visible(document.querySelector('[aria-label="Ada workbench"]'));
        result.taskDetails = rail.textContent.includes('Compare positioning across three competing products');
        document.querySelector('[aria-label="Close workbench"]').click(); await wait();
        result.returnedToThread = visible(timeline) && visible(composer);
        result.draftPreserved = field.value === 'Keep my draft';
        const recipient = document.querySelector('[aria-label="Message recipient"]');
        result.recipientUnchanged = recipient.value === '';
        const box = composer.getBoundingClientRect();
        result.composerOnScreen = box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
        result.noHorizontalOverflow = [timeline,composer,rail].filter(visible).every(node=>node.scrollWidth<=node.clientWidth+1);
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
    for (const width of [1440, 1100, 768, 390]) {
      const screenshot = process.env.DISCUSSION_SCREENSHOTS;
      if (screenshot) mkdirSync(screenshot, { recursive: true });
      const dom = execFileSync(process.env.CHROME_BIN || "google-chrome", [
        "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
        "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-sync",
        `--user-data-dir=${path.join(directory, `profile-${width}`)}`, `--window-size=${width},1000`,
        "--virtual-time-budget=6000", ...(screenshot ? [`--screenshot=${path.resolve(screenshot, `discussion-${width}.png`)}`] : []),
        "--dump-dom", pathToFileURL(file).href,
      ], { encoding: "utf8", timeout: 45_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      const match = dom.match(/<pre id="browser-result"[^>]*>(.*?)<\/pre>/);
      expect(match, `browser report at ${width}px`).not.toBeNull();
      const result = JSON.parse(match![1]);
      expect(result, `${width}px`).toMatchObject({
        mobile: width <= 1024, initialThread: true, initialComposer: true, initialActivity: width > 1024,
        overflow: false, activityVisible: true, agentTask: true, workbenchVisible: true, taskDetails: true,
        returnedToThread: true, draftPreserved: true, recipientUnchanged: true, composerOnScreen: true, noHorizontalOverflow: true,
      });
      expect(result.stopWidth).toBeLessThanOrEqual(44);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
