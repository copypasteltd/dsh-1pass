import { createRoot } from 'react-dom/client'
import { VaultWorkbench } from '../../src/client/VaultWorkbench.tsx'
import { workbenchFixture } from '../fixtures/workbench-demo.ts'
import { en, zh } from '../../src/client/locales.ts'
const params = new URLSearchParams(location.search)
const { props } = workbenchFixture({ configured: params.get('first') !== '1' })
props.t = key => (params.get('lang') === 'en' ? en : zh)[key]
createRoot(document.getElementById('root')!).render(<VaultWorkbench {...props} />)
