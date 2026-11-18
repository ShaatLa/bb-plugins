import { experimental_useRpcQuery as useQuery } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract';
export function usePreferences() {
 return useQuery({contract:rpcContract,method:'getPreferences',input:{}});
}
