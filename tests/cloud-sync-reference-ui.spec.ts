// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CloudSyncPanel } from '../src/client/CloudSyncPanel.tsx'
import type { CloudSyncPanelProps } from '../src/client/CloudSyncPanel.tsx'
import { en } from '../src/client/locales.ts'
import { vaultTranslations } from '../vendor/config-manager/src/client/vault-translations.ts'
import { SyncApi } from '../vendor/config-manager/src/client/sync/sync-api.ts'
import { SyncChannelEntryCard } from '../vendor/config-manager/src/client/sync/SyncChannelEntryCard.tsx'
import { VaultRunStore, vaultStoragePrefix } from '../vendor/config-manager/src/client/run-store.ts'
import { assertCloudSyncAction, createGuardedCloudSyncCall, safeCloudSyncResponse, vaultPayload } from '../vendor/config-manager/src/client/vault-policy.ts'
import { toastStore } from '../vendor/config-manager/src/client/common/toast-store.ts'
import type { SyncStatusResponse } from '../vendor/config-manager/src/client/sync/sync-api.ts'
import css from '../vendor/config-manager/src/client/config-manager.module.css'
const tr=vaultTranslations(()=> 'en')
const base: SyncStatusResponse = {ok:true,configured:false,credentialConfigured:false,credentialWritable:true,sectionCount:0,syncSections:[{id:'vault',displayName:'Password vault',portability:'portable',defaultIncluded:true}],autosyncByChannel: Object.fromEntries(['git','webdav','s3','gist'].map(ch=>[ch,{enabled:false,interval:'15m',running:false}])) as NonNullable<SyncStatusResponse['autosyncByChannel']>}
function setup(overrides: Partial<CloudSyncPanelProps>={}, status: SyncStatusResponse=base) {
 const call=vi.fn(async (action:string,payload?:unknown):Promise<unknown>=>{
  if(action==='status')return structuredClone(status)
  if(action==='history')return {ok:true,entries:[]}
  if(action==='githubValidate')return {ok:true,valid:false}
  if(action==='saveUiPrefs')return {ok:true}
  if(action==='snapshotsList')return {ok:true,snapshots:[]}
  if(action==='autosyncStatusAll')return status.autosyncByChannel
  if(action==='saveConfig')return {ok:true,configured:true,transport:'git',credentialConfigured:true}
  return {ok:true}
 })
 const props:CloudSyncPanelProps={t:key=>en[key],cloudSyncCall:call,readonly:false,locked:false,unavailable:false,vaultName:'test-vault',...overrides}
 const result=render(createElement(CloudSyncPanel,props));return {...result,props,call}
}
beforeEach(()=>{sessionStorage.clear();localStorage.clear();window.matchMedia=vi.fn().mockImplementation(()=>({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return true}}));})
afterEach(()=>{cleanup();toastStore.clear();vi.useRealTimers()})

test('renders original four cards in Git/WebDAV/S3/Gist order and exact unconfigured card DOM',async()=>{
 const {container}=setup();await screen.findByText(tr.syncT('history.empty'))
 const cards=[...container.querySelectorAll('.'+css.card)].filter(el=>el.textContent?.includes(tr.syncT('channel.open')))
 expect(cards).toHaveLength(4)
 for(const [i,key]of ['channel.git','channel.webdav','channel.s3','channel.gist'].entries())expect(cards[i]?.textContent).toContain(tr.syncT(key as Parameters<typeof tr.syncT>[0]))
 const original=render(createElement(SyncChannelEntryCard,{t:tr.syncT,channel:'git',statusInfo:base,remoteReady:false,repoUrl:'',webdavUrl:'',s3Endpoint:'',gistId:'',onOpen(){},onClear(){}}))
 expect(cards[0]?.innerHTML).toBe(original.container.firstElementChild?.innerHTML)
 expect(container.querySelector('select')).toBeNull()
})

test.each([
 ['git','config.repoUrl','config.token'],['webdav','webdav.url','webdav.password'],['s3','cloud.bucket','cloud.secret'],['gist','cloud.gistId','cloud.token'],
])('config dialog renders only selected %s channel fields without tabs',async(channel,field,secret)=>{
 setup();await screen.findByText(tr.syncT('history.empty'))
 const index=['git','webdav','s3','gist'].indexOf(channel)
 fireEvent.click(screen.getAllByRole('button',{name:tr.syncT('channel.open')})[index]!)
 const dialog=await screen.findByRole('dialog')
 expect(dialog.textContent).toContain(tr.syncT(field as Parameters<typeof tr.syncT>[0]))
 expect(dialog.textContent).toContain(tr.syncT(secret as Parameters<typeof tr.syncT>[0]))
 expect(dialog.querySelector('[role=tablist]')).toBeNull()
 expect(dialog.closest('[data-vault-cloud-sync]')?.getAttribute('data-vault-cloud-sync')).toBe('test-vault')
})

test('configured cards retain original folds, vault selection, forced encrypted control and disabled DSH export',async()=>{
 const status={...base,configured:true,repoUrl:'https://example.invalid/private.git',credentialConfigured:true,syncCredentialsByChannel:Object.fromEntries(['git','webdav','s3','gist'].map(ch=>[ch,{encryptPasswordConfigured:true,decryptPasswordConfigured:true}])) as SyncStatusResponse['syncCredentialsByChannel']}
 setup({},status);await screen.findByText(tr.syncT('history.empty'))
 const fold=screen.getByRole('button',{name:tr.syncT('channel.collapse')});expect(fold.getAttribute('aria-expanded')).toBe('true');fireEvent.click(fold);expect(fold.getAttribute('aria-expanded')).toBe('false');fireEvent.click(fold);expect(fold.getAttribute('aria-expanded')).toBe('true')
 const encrypt=screen.getByRole('checkbox',{name:tr.syncT('mode.encrypt')}) as HTMLInputElement
 expect(encrypt.checked).toBe(true);expect(encrypt.disabled).toBe(true)
 const secrets=screen.getByRole('checkbox',{name:tr.syncT('mode.includeSecrets')}) as HTMLInputElement
 expect(secrets.checked).toBe(false);expect(secrets.disabled).toBe(true)
 expect(document.body.textContent).not.toContain('MCP / Tools')
})

test('readonly allows viewing configuration but disables editing and rejects mutations',async()=>{
 const {call}=setup({readonly:true});await screen.findByText(tr.syncT('history.empty'))
 fireEvent.click(screen.getAllByRole('button',{name:tr.syncT('channel.open')})[0]!)
 const dialog=await screen.findByRole('dialog')
 expect([...dialog.querySelectorAll('input')].every(el=>el.disabled)).toBe(true)
 expect(()=>assertCloudSyncAction('push',{readonly:true,locked:false,unavailable:false})).toThrow()
 expect(call.mock.calls.every(([action])=>['status','history','githubValidate','saveUiPrefs'].includes(action))).toBe(true)
})

test('locked/unavailable scopes never invoke host and revoke open dialogs and drafts',async()=>{
 const {call,props,rerender}=setup();await screen.findByText(tr.syncT('history.empty'))
 fireEvent.click(screen.getAllByRole('button',{name:tr.syncT('channel.open')})[0]!)
 await screen.findByRole('dialog');const token=document.querySelector('input[type=password]')!;fireEvent.change(token,{target:{value:'synthetic-credential-do-not-store'}})
 rerender(createElement(CloudSyncPanel,{...props,locked:true}))
 expect(screen.queryByRole('dialog')).toBeNull();const count=call.mock.calls.length
 await new Promise(resolve=>setTimeout(resolve,400));expect(call.mock.calls).toHaveLength(count)
 rerender(createElement(CloudSyncPanel,{...props,vaultName:'other-vault'}));await screen.findByText(tr.syncT('history.empty'))
 fireEvent.click(screen.getAllByRole('button',{name:tr.syncT('channel.open')})[0]!)
 await screen.findByRole('dialog');expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
 expect(JSON.stringify({...sessionStorage,...localStorage})).not.toContain('synthetic-credential-do-not-store')
 expect(sessionStorage.getItem('dsh.cfgMgr.state.v1')).toBeNull();expect(localStorage.getItem('dsh.configManager.syncChannel')).toBeNull()
})

test('remote snapshots navigation renders a real remote history surface, not a dead library patch',async()=>{
 const {call}=setup();await screen.findByText(tr.syncT('history.empty'));fireEvent.click(screen.getByRole('button',{name:tr.syncT('history.remoteMovedAction')}))
 await waitFor(()=>expect(screen.getByRole('combobox')).toBeTruthy())
 expect(screen.getByText(tr.syncT('syncflow.noSnapshots'))).toBeTruthy();expect(call.mock.calls.filter(([action])=>action==='status').length).toBeGreaterThan(1)
})

test('whitelist persistence never serializes credentials, plaintext, preview or conflict values',()=>{
 const store=new VaultRunStore('one');const state=store.getSnapshot().sync
 store.patch({sync:{...state,token:'synthetic-token',webdavPassword:'synthetic-password',byChannel:{...state.byChannel,git:{...state.byChannel.git,encryptPassword:'synthetic-encrypt',decryptPassword:'synthetic-decrypt'}}}})
 const raw=sessionStorage.getItem(vaultStoragePrefix('one')+'.state.v1')!;expect(JSON.parse(raw)).toEqual({channel:'git'});expect(raw).not.toMatch(/synthetic|Password|token|preview/i)
 const other=new VaultRunStore('two');expect(other.getSnapshot().sync.token).toBe('');store.dispose();other.dispose()
 const safe=safeCloudSyncResponse({entries:[{id:'op',kind:'push',createdAt:'date'}],password:'hidden',conflicts:[{localPreview:'entry-plaintext',remotePreview:'entry-plaintext',diff:'raw-diff'}]},[])
 expect(safe).toEqual({entries:[{id:'op',kind:'push',createdAt:'date'}],conflicts:[{localPreview:'[REDACTED]',remotePreview:'[REDACTED]'}]})
})

test('policy rejects unknown/locked actions and payload always remains encrypted vault-only',async()=>{
 const host=vi.fn(async()=>({message:'synthetic-password'}));let active=true;const guard=createGuardedCloudSyncCall(host,()=>({readonly:false,locked:false,unavailable:false}),()=>active,()=>{})
 await expect(guard.call('unknown')).rejects.toThrow();expect(host).not.toHaveBeenCalled()
 expect(vaultPayload('push',{encrypt:false,includeSecrets:true,sections:['settings','vault'],sessions:{limit:1},deletePlugins:true})).toEqual({encrypt:true,includeSecrets:false,sections:['vault']})
 expect(await guard.call('saveConfig',{password:'synthetic-password'})).toEqual({message:'[REDACTED]'})
 active=false;await expect(guard.call('status')).rejects.toThrow();guard.clear()
})

test('typed facade keeps exact method actions and per-channel preview plan ids',async()=>{
 const host=vi.fn(async(action:string)=>({ok:true,planId:action==='pushPreview'?'push-plan':action==='mergePreview'?'merge-plan':undefined}))
 const api=new SyncApi(tr.uiT,host)
 await api.pushPreview({transport:'webdav'});await api.push({transport:'webdav'});await api.mergePreview({transport:'git'} as Parameters<SyncApi['mergePreview']>[0]);await api.applyMerge({transport:'git',resolutions:[]} as Parameters<SyncApi['applyMerge']>[0]);
 expect(host.mock.calls.map(([action])=>action)).toEqual(['pushPreview','push','mergePreview','applyMerge'])
 expect(host.mock.calls[1]?.[1]).toMatchObject({transport:'webdav',planId:'push-plan'});expect(host.mock.calls[3]?.[1]).toMatchObject({transport:'git',planId:'merge-plan'})
})
