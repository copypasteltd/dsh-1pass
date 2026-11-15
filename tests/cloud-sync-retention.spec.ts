import { expect,test } from 'vitest'
import { DEFAULT_RETENTION_POLICY,retentionPolicySummary,selectPruneCandidatesByPolicy,selectRetentionKeepers } from '../src/cloud-sync/retention.ts'
test('reference default retention keeps latest10 and GFS uses UTC month/year representatives',()=>{
 const items=Array.from({length:14},(_,i)=>({id:String(i),createdAt:new Date(Date.UTC(2026,i,1)).toISOString()}))
 const keep=selectRetentionKeepers(items,DEFAULT_RETENTION_POLICY)
 expect(keep.size).toBe(10)
 expect(selectPruneCandidatesByPolicy(items,DEFAULT_RETENTION_POLICY)).toHaveLength(4)
 expect(retentionPolicySummary(DEFAULT_RETENTION_POLICY)).toBeTruthy()
 const gfs=selectRetentionKeepers(items,{keepLast:1,keepMonthly:3,keepYearly:2})
 expect(gfs.has('13')).toBe(true);expect(gfs.has('12')).toBe(true);expect(gfs.has('11')).toBe(true)
})
