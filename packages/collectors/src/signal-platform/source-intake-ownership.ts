import type { EntityManagerV4Source } from './runtime-config'
import { sourceOwnershipAllows } from './source-ownership'
import { emptySourceIntakeReport, type SourceSignalIntakePort } from './source-intake'

/** Keep source observations flowing while ownership fences new admission and classifier spending. */
export function withSourceIntakeOwnership(input: {
  intake: SourceSignalIntakePort
  observationIntake: SourceSignalIntakePort
  source: EntityManagerV4Source
  databasePath: string
}): SourceSignalIntakePort {
  if (input.intake.mode !== 'active') return input.intake
  const allowed = () => sourceOwnershipAllows({databasePath:input.databasePath,source:input.source,domain:'intake',owner:'shared'})
  return {
    mode:'active',
    async ingest(signal) {
      if (allowed()) return input.intake.ingest(signal)
      const observed = await input.observationIntake.ingest(signal)
      return {...observed,mode:'active',held:'source_ownership_fenced'}
    },
    ...(input.intake.preview ? {async preview(signal) {
      if (!allowed()) throw new Error('Source ownership fences intake classification')
      return input.intake.preview!(signal)
    }} : {}),
    ...(input.intake.retryUntriaged ? {async retryUntriaged(limit) {
      return allowed() ? input.intake.retryUntriaged!(limit) : emptySourceIntakeReport('active')
    }} : {}),
    ...(input.intake.repairAdmissions ? {async repairAdmissions(limit) {
      return allowed() ? input.intake.repairAdmissions!(limit) : {repairedWorkIds:[],alreadyPresentWorkIds:[],held:[]}
    }} : {}),
  }
}
