// @vitest-environment node
import { renderInBrowser } from "./test/browser";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps every standalone page readable at desktop and narrow mobile widths", async () => {
  // Controlled UI fixtures only; persistence and provider behavior are tested separately.
  const directory = mkdtempSync(path.join(process.cwd(), "node_modules/.pages-browser-"));
  try {
    const entry = path.join(directory, "entry.tsx");
    writeFileSync(entry, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AccessGate, AccountPage } from '../../src/App';
      import { LandingPage } from '../../src/components/LandingPage';
      import { LegalPage } from '../../src/components/LegalPage';
      import { CreateCompanion } from '../../src/components/CreateCompanion';
      import { ConnectionsPage } from '../../src/components/WorkspaceConnections';
      import { CompanionSettingsPage } from '../../src/components/CompanionSettingsPage';
      import '../../src/index.css';
      import '../../src/maison.css';
      const companion = {id:'ada',name:'Ada',instructions:'Research and strategy',provider:'box',status:'ready',error:null,createdAt:'2026-09-14T10:00:00Z',avatar:{shape:1,color:2,face:0}};
      const config = {models:[{id:'great',name:'Great'}],localAvailable:true,boxAvailable:true};
      const account = {id:'github',serverId:'github',label:'Research team',provider:'github',status:'connected',healthStatus:'ok',usedBy:[]};
      window.fetch = async input => {
        const url = String(input);
        const body = url === '/api/config' ? config : url === '/api/companions/ada' ? {companion} :
          url === '/api/plugins' ? {catalog:[{id:'github',name:'GitHub',provider:'github',available:true},{id:'linear',name:'Linear',provider:'linear',available:true}],accounts:[account]} : url === '/api/companions/ada/plugins' ? {accounts:[]} :
          url === '/api/billing' ? {configured:true,mode:'beta',active:true,usage:[],plan:null} :
          url === '/api/deliveries' ? {sent:[],received:[]} : {companions:[]};
        return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
      };
      const noop = () => {};
      const pages = {
        landing:<LandingPage onLogin={noop}/>, login:<AccessGate/>,
        privacy:<LegalPage kind='privacy'/>, terms:<LegalPage kind='terms'/>,
        create:<main className='onboarding'><CreateCompanion ownerId='test' config={config} onCreated={noop}/></main>,
        applications:<ConnectionsPage onBack={noop}/>,
        account:<AccountPage user={{id:'test',name:'Sam',email:'sam.with.a.long.email@example.invalid'}} onBack={noop} onSignOut={async()=>{}}/>,
        settings:<CompanionSettingsPage id='ada' onBack={noop} onUnauthorized={noop}/>
      };
      createRoot(document.getElementById('root')).render(pages[location.hash.slice(1)]);
      setTimeout(() => {
        const visible = node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden';
        const containers = [...document.querySelectorAll('main, .account-inner, .connections-inner, .legal-header, .access-form, .create-form')].filter(visible);
        const overflows = containers.filter(node => node.scrollWidth > node.clientWidth + 1).map(node=>node.className);
        const headings = [...document.querySelectorAll('h1')].filter(visible);
        const report = document.createElement('pre'); report.hidden=true; report.id='browser-result';
        report.textContent = JSON.stringify({overflows,heading:headings.length,viewport:innerWidth}); document.body.append(report);
      },1200);
    `);
    const bundle = await build({ logLevel: "silent", build: { write: false, rollupOptions: { input: entry, output: { format: "iife", inlineDynamicImports: true } } } });
    const output = (Array.isArray(bundle) ? bundle : [bundle]).flatMap(bundle => "output" in bundle ? bundle.output : []);
    const css = output.filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css")).map(asset => asset.type === "asset" ? String(asset.source) : "").join("\n");
    const js = output.filter(asset => asset.type === "chunk").map(asset => asset.type === "chunk" ? asset.code : "").join("\n");
    const file = path.join(directory, "index.html");
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script>`);
    for (const page of ["landing", "login", "privacy", "terms", "create", "applications", "account", "settings"]) {
      for (const width of [1440, 390, 320]) {
        const screenshot = process.env.DISCUSSION_SCREENSHOTS;
        if (screenshot) mkdirSync(screenshot, { recursive: true });
        const dom = await renderInBrowser({
          url:`${pathToFileURL(file).href}#${page}`, profile:path.join(directory, `profile-${page}-${width}`), width, height:width < 500 ? 844 : 900,
          screenshot:screenshot ? path.resolve(screenshot, `${page}-${width}.png`) : undefined,
        });
        const match = dom.match(/<pre hidden="" id="browser-result"[^>]*>(.*?)<\/pre>/);
        expect(match, `${page} ${width}px produced a report`).not.toBeNull();
        expect(JSON.parse(match![1]), `${page} ${width}px`).toMatchObject({ overflows: [], heading: 1, viewport: width });
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
