import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const source=readFileSync(fileURLToPath(new URL('../skills/1pass/SKILL.md',import.meta.url)),'utf8')
test('1pass skill has portable routing metadata and safe minimal-field retrieval',()=>{
 expect(source).toMatch(/^---\nname: "1pass"\ndescription: /)
 for(const name of ['vault_search','vault_get','vault_totp','--field host','--field username','--field port'])expect(source).toContain(name)
 expect(source).toContain('multiple fuzzy matches')
 expect(source).toContain('not a login')
 expect(source).toContain('Do not fall back to `vault_fill`')
 expect(source).toContain('ID-scoped high-sensitivity')
 expect(source).toContain('not inherit the GUI')
 expect(source).toContain('never use it to bypass')
 expect(source).toContain('not guarantees that arbitrary custom data is sanitized')
 expect(source).not.toMatch(/C:\\Users\\|TODO|\u0000/)
 expect(source).not.toContain('dsh-vault get "demo-server"\n')
})
