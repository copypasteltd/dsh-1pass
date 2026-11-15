import {createContext,createElement,useContext} from 'react';
import type {ReactNode} from 'react';
const ReadonlyContext=createContext(false);
export function VaultReadonlyProvider({readonly,children}:{readonly:boolean;children:ReactNode}){return createElement(ReadonlyContext.Provider,{value:readonly},children)}
export function useVaultReadonly():boolean{return useContext(ReadonlyContext)}
