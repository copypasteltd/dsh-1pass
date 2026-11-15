import { expect, test } from 'vitest'
import { otpInputIssue } from '../src/otp-input.ts'
import { credentialSchema } from '../src/client/credential-fields.ts'
import { credentialPatch, entryToForm, restrictForm, validateCredentialForm } from '../src/client/editor-form.ts'
import { totp } from '../src/totp.ts'
const secret = 'JBSW' + 'Y3DP' + 'EHPK' + '3PXP'
const uri = 'otpauth://totp/Synthetic:account?secret=' + secret + '&issuer=Synthetic&algorithm=SHA1&digits=6&period=30'
test('every credential kind retains an optional TOTP without showing unrelated primary fields', () => {
  for (const kind of ['login','ssh','api-key','secret','oauth','cookie','card','custom']) {
    const schema=credentialSchema(kind)
    expect(schema.fields).toContain('otpSecret')
    expect(credentialPatch({title:'Synthetic',kind,otpSecret:secret},{schema,tags:[]})).toHaveProperty('otpSecret',secret)
  }
})
test('standalone authenticator requires a key, not a password, and survives edit hydration', () => {
  const schema=credentialSchema('custom',{name:'builtin:totp',kind:'totp',fields:{}},'password')
  expect(schema.authenticatorOnly).toBe(true);expect(schema.fields).not.toContain('password')
  expect(validateCredentialForm({title:'Synthetic'},schema)).toHaveProperty('otpSecret','editorErrTotpRequired')
  const draft={title:'Synthetic',kind:'custom',otpSecret:uri}
  expect(validateCredentialForm(draft,schema)).toEqual({})
  const patch=credentialPatch(draft,{schema,tags:[]})
  const edited=entryToForm({id:'synthetic',...patch,title:'Synthetic'})
  expect(restrictForm(edited,credentialSchema('custom')).otpSecret).toBe(uri)
  expect(totp(uri,59000)).toBe(totp(secret,59000))
})
test('TOTP stays intact through SSH authentication and template transitions', () => {
  const draft={kind:'ssh',title:'Synthetic',otpSecret:secret,password:'synthetic-password'}
  const changed=restrictForm(draft,credentialSchema('ssh',null,'certificate'))
  expect(changed.otpSecret).toBe(secret);expect(changed.password).toBeUndefined()
})
test('setup keys and provisioning URIs are accepted; diagnostics never repeat input', () => {
  expect(otpInputIssue(secret)).toBeUndefined();expect(otpInputIssue(uri)).toBeUndefined()
  expect(otpInputIssue('123456')).toBe('invalid')
  expect(otpInputIssue('otpauth-migration://offline?data=synthetic-not-secret')).toBe('migration')
  expect(otpInputIssue(uri.replace('SHA1','SHA256'))).toBe('algorithm')
  for(const value of ['otpauth://hotp/a?secret='+secret,'otpauth://totp/a','otpauth://totp/%XX?secret='+secret,uri+'&secret=SECOND',uri.replace('period=30','period=0'),'x'.repeat(8193)]) expect(otpInputIssue(value)).toBe('invalid')
})
test('generated Base32 spelling/URI variants preserve TOTP output and exact stored URI', () => {
  let seed=227
  for(let n=0;n<80;n++) {
    let s='';for(let k=0;k<32;k++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[seed%32]}
    const grouped=s.toLowerCase().match(/.{1,4}/g)!.join(' - ')
    const u='otpauth://totp/Synthetic%3A'+n+'?secret='+encodeURIComponent(grouped)+'&issuer=Synthetic'
    expect(otpInputIssue(grouped)).toBeUndefined();expect(otpInputIssue(u)).toBeUndefined()
    expect(totp(u,59000)).toBe(totp(s,59000))
  }
})
