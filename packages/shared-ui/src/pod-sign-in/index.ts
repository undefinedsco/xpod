/**
 * Pod sign-in front door: one presentation for every host (spec
 * docs/superpowers/specs/2026-09-29-shared-ui-pod-sign-in-design.md).
 * These components only render; hosts own requests, redirects and storage.
 */
export { PodSignInFrame, type PodSignInFrameProps } from './PodSignInFrame'
export { StorageBadge, type StorageBadgeProps } from './StorageBadge'
export { IdpChrome, type IdpChromeProps } from './IdpChrome'
export { XpodMark } from './XpodMark'
export { ScreenLayout, SourceMark } from './parts'
export {
  PodSignIn,
  type PodSignInNotice,
  type PodSignInProps,
  type PodSignInState,
  type RememberedIdentity,
} from './PodSignIn'
export {
  IdpNoWebIdView,
  IdpRegisterView,
  IdpSignInView,
  type IdpNoWebIdViewProps,
  type IdpRegisterViewProps,
  type IdpSignInViewProps,
  type IdpViewCommonProps,
} from './IdpViews'
export { ConsentView, type ConsentViewProps, type ConsentWebId } from './ConsentView'
export {
  ConsentResumeBanner,
  CreateWebIdForm,
  CredentialSection,
  DeviceSection,
  WebIdSection,
  type ConsentResumeBannerProps,
  type CreateWebIdFormProps,
  type CredentialEntry,
  type CredentialSectionProps,
  type DeviceSectionProps,
  type UnlinkedPodEntry,
  type WebIdEntry,
  type WebIdSectionProps,
} from './AccountSections'
export {
  AddDeviceDialog,
  DevicePickerDialog,
  type AddDeviceDialogProps,
  type AddDeviceStep,
  type DevicePickerDialogProps,
} from './DeviceDialogs'
export {
  NetworkPanel,
  type NetworkChecks,
  type NetworkPanelProps,
  type ProbeState,
  type TunnelFieldDescriptor,
  type TunnelOption,
} from './NetworkPanel'
export type { DeviceStatus, DeviceSummary } from './account-parts'
export {
  formatCopy,
  podSignInCopy,
  resolvePodSignInCopy,
  type PodSignInCopy,
  type PodSignInLocale,
} from './copy'
export type {
  AppIdentity,
  SignInPresentation,
  StorageLocation,
  StorageLocationKind,
} from './types'
export { webIdShortName } from './webid-name'
