import type { AppShellService } from '@deepseek-ai/dsh-client-web'
import type { HostApi, SettingsApi, WorkspaceApi } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  OpenloopDesktopDescriptionInput,
  OpenloopSettingsDescriptionInput,
  OpenloopShellInput,
  OpenloopWorkspaceListInput,
} from '../src/index.ts'

type Assert<Condition extends true> = Condition
type Assignable<Source, Target> = [Source] extends [Target] ? true : false
type IsNever<Value> = [Value] extends [never] ? true : false
type SuccessValue<Method extends (...args: never[]) => Promise<unknown>> =
  Awaited<ReturnType<Method>> extends { result: infer Result }
    ? Extract<Result, { readonly ok: true }> extends { readonly value: infer Value }
      ? Value
      : never
    : never

type CurrentWorkspaceList = SuccessValue<WorkspaceApi['list']>
type CurrentSettingsDescription = SuccessValue<SettingsApi['describe']>
type CurrentDesktopDescription = SuccessValue<HostApi['describe']>

export type CurrentWorkspaceResponseContract = Assert<
  IsNever<CurrentWorkspaceList> extends true ? false : true
>
export type CurrentSettingsResponseContract = Assert<
  IsNever<CurrentSettingsDescription> extends true ? false : true
>
export type CurrentDesktopResponseContract = Assert<
  IsNever<CurrentDesktopDescription> extends true ? false : true
>
export type CurrentShellContract = Assert<
  Assignable<AppShellService, OpenloopShellInput>
>
export type CurrentWorkspaceContract = Assert<
  Assignable<CurrentWorkspaceList, OpenloopWorkspaceListInput>
>
export type CurrentSettingsContract = Assert<
  Assignable<CurrentSettingsDescription, OpenloopSettingsDescriptionInput>
>
export type CurrentDesktopContract = Assert<
  Assignable<CurrentDesktopDescription, OpenloopDesktopDescriptionInput>
>
