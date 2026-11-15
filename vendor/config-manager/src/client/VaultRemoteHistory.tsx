/** Vault-only remote library; rows are the original MIT config-manager ArtifactRowView. */
import { useEffect, useState } from 'react';
import type { TranslateNS } from './client-types.ts';
import type { SyncApi, SyncPushPayload, SyncSnapshotLite, SyncStartResponse } from './sync/sync-api.ts';
import type { SyncChannel } from './sync/sync-view.ts';
import { SyncConfirmView } from './sync/SyncConfirmView.tsx';
import { UnreadableSnapshotsBanner } from './sync/UnreadableSnapshotsBanner.tsx';
import { ArtifactRowView } from './library/ArtifactRow.tsx';
import { toArtifactRows } from '../ui/artifact-view.ts';
import type { ArtifactCapability, ArtifactRow } from '../ui/artifact-view.ts';
import { formatDateTimeFull } from './sync/history-model.ts';
import { Button, Card, SectionTitle } from './common/ui.tsx';
import { ErrorBanner } from './common/ErrorBanner.tsx';
import { Modal } from './common/Modal.tsx';
import { ConfirmDialog } from './common/ConfirmDialog.tsx';
import { Select } from './common/Select.tsx';
import { ConsultCard } from './consult/ConsultCard.tsx';
import type { ConsultReport } from '../core/migration-consult.ts';
import type { SyncConfirmDecisions } from './run-store.ts';
import css from './config-manager.module.css';
export interface VaultRemoteHistoryProps { api: SyncApi; t: TranslateNS<'config-manager-sync'>; cmT: TranslateNS<'config-manager'>; readonly: boolean; onBack: () => void }
export function VaultRemoteHistory({api,t,cmT,readonly,onBack}: VaultRemoteHistoryProps) {
 const [channel,setChannel]=useState<SyncChannel>('git');
 const [items,setItems]=useState<SyncSnapshotLite[]>([]); const [body,setBody]=useState<SyncPushPayload>({transport:'git'});
 const [error,setError]=useState<string|null>(null); const [loading,setLoading]=useState(false); const [tick,setTick]=useState(0);
 const [unreadable,setUnreadable]=useState<{file:string;reason:string}[]>([]); const [current,setCurrent]=useState<string|null>(null);
 const [expanded,setExpanded]=useState<string|null>(null); const [pending,setPending]=useState<{key:string;capability:ArtifactCapability}|null>(null);
 const [remove,setRemove]=useState<ArtifactRow|null>(null); const [session,setSession]=useState<SyncStartResponse|null>(null); const [decisions,setDecisions]=useState<SyncConfirmDecisions|null>(null);
 const [consult,setConsult]=useState<ConsultReport|null>(null);
 useEffect(()=>{let cancelled=false;setLoading(true);setError(null);void (async()=>{try {
  const s=await api.status({workDirDetail:false});
  const payload: SyncPushPayload = channel==='webdav'?{transport:channel,...(s.webdav?.url?{url:s.webdav.url}:{})}:channel==='s3'?{transport:channel,...s.s3}:channel==='gist'?{transport:channel,...s.gist}:{transport:channel,...(s.repoUrl?{repoUrl:s.repoUrl}:{})};
  const configured=channel==='git'?!!s.repoUrl:channel==='webdav'?!!s.webdav?.url:channel==='s3'?!!s.s3:!!s.gist;
  const list=configured?await api.snapshotsList(payload):{snapshots:[],unreadable:[],currentSnapshotId:undefined};
  if(cancelled)return;setBody(payload);setItems(list.snapshots);setUnreadable(list.unreadable??[]);setCurrent(list.currentSnapshotId??null);
 }catch{if(!cancelled)setError(t('load.failed'))}finally{if(!cancelled)setLoading(false)}})();return()=>{cancelled=true}},[api,channel,tick]);
 const run=async(capability:ArtifactCapability,row:ArtifactRow):Promise<void>=>{
  if(capability==='delete'){setRemove(row);return;}setPending({key:row.key,capability});setError(null);
  try{if(capability==='pull'){if(readonly)return;const next=await api.sync({...body,snapshotId:(row.ref.remoteId ?? '')});setSession(next);setDecisions(null)}
  else if(capability==='consult')setConsult(await api.consult({transport:channel,type:'remote-snapshot',id:(row.ref.remoteId ?? ''),snapshotId:(row.ref.remoteId ?? '')}));}
  catch{setError(t('load.failed'))}finally{setPending(null)}
 };
 const rows=toArtifactRows({remoteSnapshots:items,remoteCurrentId:current},api.t).map(row=>({...row,capabilities:(readonly?['consult']:['pull','consult','delete']) as ArtifactCapability[]}));
 return <div className={css.viewBody}>
  <div className={css.actionRow}><Button onClick={onBack}>{cmT('common.back')}</Button></div>
  <SectionTitle title={t('history.remoteMovedAction')} />
  <div className={css.controlRow}><Select value={channel} onChange={v=>{if(v==='git'||v==='webdav'||v==='s3'||v==='gist')setChannel(v)}} options={[{value:'git',label:t('channel.git')},{value:'webdav',label:t('channel.webdav')},{value:'s3',label:'S3'},{value:'gist',label:'Gist'}]} ariaLabel={t('channel.title')}/><Button onClick={()=>setTick(v=>v+1)} loading={loading}>{t('syncflow.refreshSnapshots')}</Button></div>
  {error!==null&&<ErrorBanner error={error} t={api.t} onRetry={()=>setTick(v=>v+1)}/>}
  <UnreadableSnapshotsBanner items={unreadable} t={t}/>
  <Card>{rows.length===0&&!loading?<p>{t('syncflow.noSnapshots')}</p>:<ul className={css.artifactList}>{rows.map(row=><ArtifactRowView key={row.key} row={row} t={cmT} uiT={api.t} formatTime={formatDateTimeFull} expanded={expanded===row.key} onToggle={()=>setExpanded(expanded===row.key?null:row.key)} onAction={(cap,item)=>{void run(cap,item)}} pending={pending?.key===row.key?pending.capability:null}/>)}</ul>}</Card>
  <ConfirmDialog open={remove!==null} title={cmT('library.cap.delete')} confirmLabel={cmT('library.cap.delete')} cancelLabel={cmT('common.cancel')} danger busy={pending!==null} onCancel={()=>setRemove(null)} onConfirm={()=>{if(remove===null||readonly)return;const target=remove;setPending({key:target.key,capability:'delete'});void api.deleteSnapshot({...body,snapshotId:(target.ref.remoteId ?? '')}).then(()=>{setRemove(null);setTick(v=>v+1)},()=>setError(t('load.failed'))).finally(()=>setPending(null))}}>{cmT('vault.remoteDeleteConfirm')}</ConfirmDialog>
  <Modal open={session!==null} onClose={()=>setSession(null)} title={t('syncflow.selectSnapshot')} wide><Modal.Header title={t('syncflow.selectSnapshot')} closeLabel={cmT('common.close')} onClose={()=>setSession(null)}/><Modal.Body scroll>{session!==null&&<SyncConfirmView api={api} t={t} syncSessionId={session.syncSessionId} snapshotId={session.snapshotId} items={session.items} needsReview={session.needsReview} compatibility={session.compatibility} decisions={decisions} onDecisionsChange={setDecisions} onCancel={()=>setSession(null)}/>}</Modal.Body></Modal>
  <Modal open={consult!==null} onClose={()=>setConsult(null)} title={cmT('library.cap.consult')} wide><Modal.Header title={cmT('library.cap.consult')} closeLabel={cmT('common.close')} onClose={()=>setConsult(null)}/><Modal.Body scroll>{consult!==null&&<ConsultCard report={consult} t={api.t}/>}</Modal.Body></Modal>
 </div>
}
