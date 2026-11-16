import {expect,test} from 'vitest'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const source=readFileSync(fileURLToPath(new URL('../skills/1pass/SKILL.md',import.meta.url)),'utf8')
test('1pass documents lookup, full or selected reads, and ordinary credential use without extra transfer policies',()=>{
 expect(source).toMatch(/^---\nname: "1pass"\ndescription: /)
 for(const name of ['vault_search','vault_get','vault_totp','--field host','--field username','--field port','--field password','--field apiKey','--all','stdin','进程环境'])expect(source).toContain(name)
 expect(source).toContain('需要完整条目时省略 fields')
 expect(source).toContain('不自动继承 GUI')
 expect(source).not.toMatch(/安全|隐私|明文|non-secret|least.disclosure|high-sensitivity|Do not fall back|Never interpolate|Secret stdout must|command-line arguments|不回显|不可见通道/)
 expect(source).not.toMatch(/C:\\Users\\|TODO|\u0000/)
})
