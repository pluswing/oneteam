import { formatDisplayValue } from "../formatters";
import { CheckCircle2, ExternalLink, GitPullRequest, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentJobDto, ProjectDto } from "../../shared/types";
import type { ScanFailureDiagnosis, VulnerabilityDashboard, VulnerabilityRecord, VulnerabilityRemediation, VulnerabilityScanState, VulnerabilityScanTarget, VulnerabilityScope, VulnerabilitySettings, VulnerabilitySeverity } from "../../shared/vulnerabilities";
import { groupVulnerabilityFindings } from "../../shared/vulnerability-groups";
import { buildVulnerabilityRemediationPlan, type VulnerabilityPlanExclusionReason, type VulnerabilityRemediationPlan } from "../../shared/vulnerability-plan";
import { api } from "../api";
import { AsyncState } from "../components/AsyncState";
import { formatDateTime } from "../formatters";
import { getLocale, t } from "../i18n";
import { localizeVulnerabilityMessage, localizeVulnerabilityTargetKind, localizeVulnerabilityTargetLabel } from "../vulnerability-localization";

const severityOrder: VulnerabilitySeverity[] = ["critical", "high", "medium", "low", "unknown"];
const scopes: VulnerabilityScope[] = ["application", "container", "deployment"];
const terminalStatuses = new Set(["succeeded", "canceled", "failed"]);

function latestRemediation(finding: VulnerabilityRecord, remediations: VulnerabilityRemediation[]): VulnerabilityRemediation | undefined {
  return [...remediations]
    .filter((item) => item.findingIds.includes(finding.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function sourceLinks(finding: VulnerabilityRecord): string[] {
  const osvSource = (!finding.kind || finding.kind === "vulnerability") && (!finding.scanner || finding.scanner === "osv") ? [`https://osv.dev/vulnerability/${encodeURIComponent(finding.advisoryId)}`] : [];
  return [...new Set([...osvSource, ...finding.references, ...(finding.lifecycle?.sourceUrl ? [finding.lifecycle.sourceUrl] : [])])]
    .filter((value) => {
      try { return ["https:", "http:"].includes(new URL(value).protocol); }
      catch { return false; }
    });
}

function itemLabel(finding: VulnerabilityRecord): string {
  return t(finding.kind === "coverage_gap" ? "vulnerabilities.coverageGapItem" : finding.kind === "scan_failure" ? "vulnerabilities.scanFailureItem"
    : finding.kind === "support_end" || finding.kind === "platform_update" ? `vulnerabilities.update_${finding.lifecycle?.componentKind ?? "os"}`
      : "vulnerabilities.vulnerabilityItem");
}

function synthesizedCopy(finding: VulnerabilityRecord): { summary: string; details: string } | null {
  if (finding.kind === "coverage_gap" && finding.coverageGap) return {
    summary: t(`vulnerabilities.coverageGap_${finding.coverageGap.category}`),
    details: t("vulnerabilities.coverageGapDetails")
  };
  if (finding.kind === "support_end" && finding.lifecycle) {
    const product = `${finding.lifecycle.product} ${finding.lifecycle.cycle}`.trim();
    return {
      summary: t("vulnerabilities.supportEndSummary").replace("{product}", product),
      details: t("vulnerabilities.supportEndDetails").replace("{product}", product)
    };
  }
  if (finding.kind === "platform_update" && finding.lifecycle) {
    const product = `${finding.lifecycle.product} ${finding.installedVersion}`.trim();
    return {
      summary: t("vulnerabilities.platformUpdateSummary").replace("{product}", product),
      details: t("vulnerabilities.platformUpdateDetails")
    };
  }
  if (finding.kind === "scan_failure" && finding.scanFailure) return {
    summary: t(`vulnerabilities.scanFailure_${finding.scanFailure.category}`),
    details: t(`vulnerabilities.recovery_${finding.scanFailure.recoveryStatus}`)
  };
  return null;
}

export function VulnerabilityMessage(props: { message: string; locale?: string }) {
  const localized = localizeVulnerabilityMessage(props.message, props.locale ?? getLocale());
  return <div className="vulnerability-message"><p>{localized}</p>{localized !== props.message ? <details className="vulnerability-original">
    <summary>{t("vulnerabilities.originalText")}</summary><p className="vulnerability-details" lang="en">{props.message}</p>
  </details> : null}</div>;
}

export function VulnerabilityRecovery(props: { diagnosis: ScanFailureDiagnosis; locale?: string }) {
  const { diagnosis } = props;
  return <div className="vulnerability-recovery">
    <strong>{t(`vulnerabilities.scanFailure_${diagnosis.category}`)}</strong>
    <p>{t(`vulnerabilities.recovery_${diagnosis.recoveryStatus}`)}</p>
    {diagnosis.attemptedActions.length ? <><strong>{t("vulnerabilities.attemptedActions")}</strong><ul>{diagnosis.attemptedActions.map((action, index) => <li key={index}><VulnerabilityMessage message={action} locale={props.locale} /></li>)}</ul></> : null}
    <details className="vulnerability-original"><summary>{t("vulnerabilities.originalDiagnostics")}</summary><strong>{diagnosis.summary}</strong><p className="vulnerability-details">{diagnosis.details}</p></details>
  </div>;
}

export function VulnerabilityFindings(props: {
  findings: VulnerabilityRecord[];
  remediations: VulnerabilityRemediation[];
  scan?: VulnerabilityScanState;
  locale?: string;
  planDisposition?: "included" | "excluded";
  exclusionReasons?: Map<string, VulnerabilityPlanExclusionReason>;
  onOpenPullRequest: (id: number) => void;
}) {
  const locale = props.locale ?? getLocale();
  const japanese = /^ja(?:-|$)/i.test(locale);
  return <div className="vulnerability-table-scroll">
    <table className="vulnerability-table">
      <thead><tr>
        <th scope="col">{t("vulnerabilities.severityAndType")}</th>
        <th scope="col">{t("vulnerabilities.advisory")}</th>
        <th scope="col">{t("vulnerabilities.dependency")}</th>
        <th scope="col">{t("vulnerabilities.fixedVersions")}</th>
        <th scope="col">{t("vulnerabilities.action")}</th>
      </tr></thead>
      <tbody>{props.findings.map((finding) => {
        const remediation = latestRemediation(finding, props.remediations);
        const exclusionReason = props.exclusionReasons?.get(finding.id);
        const activeRemediation = remediation && !["succeeded", "canceled"].includes(remediation.status);
        const translation = finding.translations?.ja;
        const sourceJapanese = /[\u3040-\u30ff\u3400-\u9fff]/u.test(finding.summary) && (!finding.details.trim() || /[\u3040-\u30ff\u3400-\u9fff]/u.test(finding.details));
        const translated = japanese && translation?.status === "translated";
        const synthesized = synthesizedCopy(finding);
        const waiting = !synthesized && japanese && !translated && !sourceJapanese;
        const useJapaneseLifecycle = finding.kind === "support_end" && japanese && sourceJapanese;
        const summary = useJapaneseLifecycle ? finding.summary : synthesized?.summary ?? (translated ? translation.summary : waiting ? t("vulnerabilities.translationSummary").replace("{package}", finding.packageName) : finding.summary);
        const details = useJapaneseLifecycle ? finding.details : synthesized?.details ?? (translated ? translation.details : waiting ? "" : finding.details);
        const synthetic = finding.kind === "support_end" || finding.kind === "platform_update" || finding.kind === "scan_failure" || finding.kind === "coverage_gap";
        return <tr key={finding.id} data-finding-id={finding.id} data-finding-kind={finding.kind ?? "vulnerability"}>
          <td>{synthetic ? <span className={`vulnerability-severity finding-kind-${finding.kind}`}>{itemLabel(finding)}</span>
            : <span className={`vulnerability-severity severity-${finding.severity}`}>{t(`vulnerabilities.${finding.severity}`)}</span>}</td>
          <td className="vulnerability-advisory">
            <strong>{summary || finding.advisoryId}</strong>
            {!synthetic ? <code>{finding.advisoryId}</code> : null}
            {waiting ? <span className="vulnerability-translation-status">{t(translation?.status === "failed" ? "vulnerabilities.translationFailed" : "vulnerabilities.translationPending")}</span> : null}
            <details>
              <summary>{t("vulnerabilities.details")}</summary>
              {details ? <p className="vulnerability-details" lang={japanese ? "ja" : undefined}>{details}</p> : null}
              {finding.scanFailure ? <VulnerabilityMessage message={finding.scanFailure.summary} locale={locale} /> : null}
              {finding.coverageGap ? <><VulnerabilityMessage message={finding.coverageGap.action} locale={locale} /><ul>{finding.coverageGap.warnings.map((warning) => <li key={warning}><VulnerabilityMessage message={warning} locale={locale} /></li>)}</ul></> : null}
              {finding.lifecycle?.supportEndedAt ? <p>{t("vulnerabilities.supportEndedAt")} <time dateTime={finding.lifecycle.supportEndedAt}>{finding.lifecycle.supportEndedAt}</time></p> : null}
              {finding.scanFailure?.attemptedActions.length ? <div className="vulnerability-recovery-actions"><strong>{t("vulnerabilities.attemptedActions")}</strong><ul>{finding.scanFailure.attemptedActions.map((action, index) => <li key={index}><VulnerabilityMessage message={action} locale={locale} /></li>)}</ul></div> : null}
              {(synthesized || (japanese && !sourceJapanese)) ? <details className="vulnerability-original"><summary>{t(synthetic ? "vulnerabilities.originalDiagnostics" : "vulnerabilities.originalText")}</summary><strong lang={synthetic ? undefined : "en"}>{finding.summary}</strong>{finding.details ? <p className="vulnerability-details" lang={synthetic ? undefined : "en"}>{finding.details}</p> : null}</details> : null}
              {finding.aliases.length ? <p>{finding.aliases.join(" · ")}</p> : null}
              <ul className="vulnerability-sources">{sourceLinks(finding).map((url) => <li key={url}>
                <a href={url} rel="noopener noreferrer" target="_blank">{url}<ExternalLink aria-hidden="true" size={12} /></a>
              </li>)}</ul>
              <dl className="vulnerability-dates">
                <div><dt>{t("vulnerabilities.firstSeen")}</dt><dd>{formatDateTime(finding.firstSeenAt)}</dd></div>
                <div><dt>{t("vulnerabilities.lastSeen")}</dt><dd>{formatDateTime(finding.lastSeenAt)}</dd></div>
                {finding.resolvedAt ? <div><dt>{t("vulnerabilities.resolvedAt")}</dt><dd>{formatDateTime(finding.resolvedAt)}</dd></div> : null}
              </dl>
            </details>
          </td>
          <td className="vulnerability-dependency"><strong>{finding.packageName}</strong><code>{finding.installedVersion}</code><span>{finding.ecosystem}</span><code>{finding.manifestPath}</code><span>{t(`vulnerabilities.scope_${finding.scope ?? "application"}`)}</span>{finding.targetLabel ? <code>{localizeVulnerabilityTargetLabel(finding.targetLabel, locale)}</code> : null}</td>
          <td>{finding.fixedVersions.length ? <span className="vulnerability-versions">{finding.fixedVersions.join(", ")}</span> : <span className="muted-text">{t(finding.kind === "coverage_gap" ? "vulnerabilities.coverageGapItem" : finding.kind === "support_end" || finding.kind === "platform_update" ? "vulnerabilities.supportedVersionRequired" : finding.kind === "scan_failure" ? "vulnerabilities.scannerRecoveryRequired" : "vulnerabilities.noFix")}</span>}</td>
          <td>
            <div className="vulnerability-response">
              {finding.status === "resolved" ? <span className="vulnerability-resolved"><CheckCircle2 aria-hidden="true" size={15} />{t("vulnerabilities.resolved")}</span>
                : exclusionReason ? <span className="muted-text">{t(`vulnerabilities.planExcluded_${exclusionReason}`)}</span>
                  : activeRemediation ? <span>{t(`development.${remediation.status}`)}</span>
                    : props.planDisposition === "included" ? <span>{t("vulnerabilities.includedInPlan")}</span>
                      : remediation ? <span>{remediation.status === "succeeded" ? t("vulnerabilities.awaitingConfirmation") : t(`development.${remediation.status}`)}</span>
                    : finding.remediationMode === "external" ? <span className="muted-text">{t(finding.kind === "scan_failure" ? "vulnerabilities.externalRecovery" : "vulnerabilities.externalFix")}</span>
                        : <span className="muted-text">{t(finding.fixedVersions.length || finding.kind && finding.kind !== "vulnerability" ? "vulnerabilities.planReviewRequired" : "vulnerabilities.noFix")}</span>}
              {remediation?.pullRequestId ? <a href={`/pulls/${remediation.pullRequestId}`} onClick={(event) => { event.preventDefault(); props.onOpenPullRequest(remediation.pullRequestId!); }}>PR #{remediation.pullRequestId}</a> : null}
            </div>
          </td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

export function VulnerabilityGroups(props: Parameters<typeof VulnerabilityFindings>[0] & { allFindings?: VulnerabilityRecord[] }) {
  const visibleIds = new Set(props.findings.map((finding) => finding.id));
  const groups = groupVulnerabilityFindings(props.allFindings ?? props.findings, props.scan?.targets).filter((group) => group.findings.some((finding) => visibleIds.has(finding.id)));
  return <div className="vulnerability-groups"><p className="vulnerability-group-total muted-text">{t("vulnerabilities.updateTargetCount").replace("{count}", String(groups.length))}</p>{groups.map((group) => {
    const children = group.findings.filter((finding) => visibleIds.has(finding.id));
    const vulnerabilities = group.findings.filter((finding) => !finding.kind || finding.kind === "vulnerability");
    const eol = group.findings.filter((finding) => finding.kind === "support_end").length;
    const platformUpdates = group.findings.filter((finding) => finding.kind === "platform_update").length;
    const resolved = group.findings.every((finding) => finding.status === "resolved");
    const active = group.findings.map((finding) => latestRemediation(finding, props.remediations)).find((remediation) => remediation && !terminalStatuses.has(remediation.status));
    const title = t(`vulnerabilities.groupTitle_${group.kind}`).replace("{name}", localizeVulnerabilityTargetLabel(group.name, props.locale ?? getLocale()));
    return <article className={`vulnerability-group group-severity-${group.severity}`} key={group.id} data-remediation-kind={group.kind}>
      <header className="vulnerability-group-header"><div>
        <div className="vulnerability-group-risk">{vulnerabilities.length ? <span className={`vulnerability-severity severity-${group.severity}`}>{t("vulnerabilities.highestSeverity")} {t(`vulnerabilities.${group.severity}`)}</span> : null}
          {eol ? <span className="vulnerability-severity finding-kind-support_end">{t("vulnerabilities.supportEndCount").replace("{count}", String(eol))}</span> : null}
          {platformUpdates ? <span className="vulnerability-severity finding-kind-platform_update">{t("vulnerabilities.platformUpdateCount").replace("{count}", String(platformUpdates))}</span> : null}
          {group.kind === "scan_failure" ? <span className="vulnerability-severity finding-kind-scan_failure">{t("vulnerabilities.scanFailureItem")}</span> : null}
          {group.kind === "coverage_gap" ? <span className="vulnerability-severity finding-kind-coverage_gap">{t("vulnerabilities.coverageGapItem")}</span> : null}
        </div>
        <h3>{title}</h3>
        <div className="vulnerability-group-subject"><code>{group.reference || group.name}</code><span>{t(`vulnerabilities.scope_${group.scope}`)}</span></div>
      </div><div className="vulnerability-response">
        {resolved ? <span className="vulnerability-resolved"><CheckCircle2 aria-hidden="true" size={15} />{t("vulnerabilities.resolved")}</span>
          : group.external ? <span className="muted-text">{t(group.kind === "scan_failure" ? "vulnerabilities.externalRecovery" : "vulnerabilities.externalFix")}</span>
            : active ? <span>{t(`development.${active.status}`)}</span>
              : props.planDisposition === "included" ? <span>{t("vulnerabilities.includedInPlan")}</span> : null}
      </div></header>
      <p className="vulnerability-group-explanation">{t(group.kind === "coverage_gap" ? "vulnerabilities.coverageGroupHint" : group.kind === "image" ? "vulnerabilities.imageGroupHint" : group.kind === "environment" ? "vulnerabilities.environmentGroupHint" : group.kind === "scan_failure" ? "vulnerabilities.scannerGroupHint" : group.kind === "support_end" || group.kind === "platform_update" ? "vulnerabilities.platformGroupHint" : "vulnerabilities.dependencyGroupHint")}</p>
      <ul className="vulnerability-group-targets">{[...new Set(group.findings.map((finding) => `${finding.manifestPath}${finding.targetLabel ? ` · ${localizeVulnerabilityTargetLabel(finding.targetLabel, props.locale ?? getLocale())}` : ""}`))].map((target) => <li key={target}><code>{target}</code></li>)}</ul>
      <div className="vulnerability-group-counts">{severityOrder.map((severity) => {
        const count = vulnerabilities.filter((finding) => finding.severity === severity).length;
        return count ? <span key={severity} className={`vulnerability-severity severity-${severity}`}>{t(`vulnerabilities.${severity}`)} {count}</span> : null;
      })}<span>{t("vulnerabilities.containedFindings").replace("{count}", String(group.findings.length))}</span></div>
      {children.length !== group.findings.length ? <p className="muted-text">{t("vulnerabilities.filteredChildren").replace("{count}", String(children.length)).replace("{total}", String(group.findings.length))}</p> : null}
      <details className="vulnerability-group-children"><summary>{t("vulnerabilities.viewChildFindings").replace("{count}", String(children.length))}</summary>
        <VulnerabilityFindings {...props} findings={children} />
      </details>
    </article>;
  })}</div>;
}

export function VulnerabilityAssessment(props: { plan: VulnerabilityRemediationPlan; locale?: string }) {
  const { assessment } = props.plan;
  return <section className="vulnerability-assessment" data-testid="vulnerability-assessment" aria-labelledby="vulnerability-assessment-title">
    <header className="vulnerability-assessment-header"><h3 id="vulnerability-assessment-title">{t("vulnerabilities.assessmentTitle")}</h3>
      <span className={`vulnerability-assessment-status assessment-${assessment.status}`}>{t(`vulnerabilities.assessment_${assessment.status}`)}</span>
    </header>
    <p>{t(`vulnerabilities.assessmentRecommendation_${assessment.status}`)}</p>
    {assessment.components.length ? <div className="vulnerability-table-scroll"><table className="vulnerability-table vulnerability-assessment-table">
      <thead><tr><th scope="col">{t("vulnerabilities.platformComponent")}</th><th scope="col">{t("vulnerabilities.currentVersion")}</th><th scope="col">{t("vulnerabilities.maintenanceStatus")}</th><th scope="col">{t("vulnerabilities.latestSupportedVersion")}</th><th scope="col">{t("vulnerabilities.assessmentSource")}</th></tr></thead>
      <tbody>{assessment.components.map((component, index) => {
        let source: string | null = null;
        try { if (component.sourceUrl && ["https:", "http:"].includes(new URL(component.sourceUrl).protocol)) source = component.sourceUrl; } catch { /* Ignore unsafe or malformed source links. */ }
        return <tr key={`${component.targetId}:${component.product}:${index}`}>
          <th scope="row"><strong>{component.product}</strong><span>{t(`vulnerabilities.component_${component.componentKind}`)}</span></th>
          <td><code>{component.version || t("vulnerabilities.versionUnknown")}</code></td>
          <td><span className={`vulnerability-assessment-status maintenance-${component.status}`}>{t(`vulnerabilities.maintenance_${component.status}`)}</span></td>
          <td>{component.latestSupportedVersion ? <code>{component.latestSupportedVersion}</code> : <span className="muted-text">{t("vulnerabilities.versionUnknown")}</span>}</td>
          <td>{source ? <a href={source} target="_blank" rel="noopener noreferrer">{t("vulnerabilities.assessmentSource")}<ExternalLink aria-hidden="true" size={12} /></a> : <span className="muted-text">{t("vulnerabilities.sourceUnknown")}</span>}</td>
        </tr>;
      })}</tbody>
    </table></div> : <p className="muted-text">{t("vulnerabilities.assessmentNoComponents")}</p>}
    {assessment.reasons.length ? <ul className="vulnerability-assessment-reasons">{assessment.reasons.map((reason, index) => <li key={index}><VulnerabilityMessage message={reason} locale={props.locale} /></li>)}</ul> : null}
    {assessment.status === "unknown" ? <p className="vulnerability-assessment-caution" role="note">{t("vulnerabilities.assessmentUnknownCaution")}</p> : null}
  </section>;
}

export function VulnerabilityPlan(props: {
  dashboard: VulnerabilityDashboard;
  busy: boolean;
  locale?: string;
  deferred: boolean;
  onApprove: () => void;
  onDefer: () => void;
}) {
  const plan = props.dashboard.remediationPlan ?? buildVulnerabilityRemediationPlan(props.dashboard);
  const locale = props.locale ?? getLocale();
  const scanning = ["never", "scanning"].includes(props.dashboard.scan.status);
  const executable = plan.phaseStatus === "ready";
  const platformFirst = ["outdated_platform", "urgent_platform"].includes(plan.assessment.status);
  const minimalVerified = props.dashboard.remediations.some((remediation) => remediation.stage === "minimal_dependencies" && remediation.verifiedAt);
  const stages = platformFirst ? ["modernization", "minimal_dependencies"] as const : ["minimal_dependencies", "modernization"] as const;
  return <section className="vulnerability-plan" data-testid="vulnerability-plan" data-stage={plan.stage} data-phase-status={plan.phaseStatus} aria-labelledby="vulnerability-plan-title">
    <h2 id="vulnerability-plan-title">{t("vulnerabilities.planTitle")}</h2>
    <p>{t("vulnerabilities.planPolicy")}</p>
    <VulnerabilityAssessment plan={plan} locale={locale} />
    <ol className="vulnerability-stage-list" aria-label={t("vulnerabilities.stagedWorkflow")}>
      {stages.map((stage, index) => {
        const skipped = platformFirst && stage === "minimal_dependencies";
        const complete = !skipped && (stage === "minimal_dependencies" ? plan.prerequisiteComplete && plan.stage !== stage : plan.stage === stage && plan.phaseStatus === "complete");
        const current = !skipped && plan.stage === stage;
        const caption = skipped ? "vulnerabilities.stageBypassed" : complete ? stage === "minimal_dependencies" && !minimalVerified ? "vulnerabilities.stageNoMinimalRepairs" : "vulnerabilities.stageVerified" : current ? `vulnerabilities.phase_${plan.phaseStatus}`
          : stage === "modernization" ? "vulnerabilities.stageRequiresVerification" : "vulnerabilities.stageAfterAssessment";
        return <li key={stage} className={skipped ? "stage-skipped" : complete ? "stage-complete" : current ? "stage-current" : "stage-pending"} aria-current={current ? "step" : undefined}>
          <span className="vulnerability-stage-number" aria-hidden="true">{complete ? <CheckCircle2 size={18} /> : skipped ? "—" : index + 1}</span><div><strong>{t(`vulnerabilities.stage_${stage}`)}</strong><p>{t(`vulnerabilities.stageDescription_${stage}`)}</p><span className="vulnerability-stage-caption">{t(caption)}</span></div>
        </li>;
      })}
    </ol>
    <div className="vulnerability-current-stage"><h3>{t("vulnerabilities.currentStage")} {t(`vulnerabilities.stage_${plan.stage}`)}</h3><span className={`vulnerability-assessment-status phase-${plan.phaseStatus}`}>{t(`vulnerabilities.phase_${plan.phaseStatus}`)}</span></div>
    <p>{t(platformFirst && plan.stage === "modernization" ? "vulnerabilities.planPolicy_platform_first" : plan.stage === "modernization" && !minimalVerified ? "vulnerabilities.planPolicy_modernization_no_minimal" : `vulnerabilities.planPolicy_${plan.stage}`)}</p>
    <p className="vulnerability-plan-counts">{t("vulnerabilities.planCounts").replace("{critical}", String(plan.criticalCount)).replace("{high}", String(plan.highCount)).replace("{included}", String(plan.findingIds.length)).replace("{excluded}", String(plan.excluded.length))}</p>
    {plan.excludedCriticalCount || plan.excludedHighCount ? <div className="vulnerability-plan-blockers" role="note">
      <strong>{t("vulnerabilities.planRemainingRisk").replace("{critical}", String(plan.excludedCriticalCount)).replace("{high}", String(plan.excludedHighCount))}</strong>
      <p>{t("vulnerabilities.planBlockersHint")}</p>
      <ul>{props.dashboard.findings.filter((finding) => plan.excluded.some((item) => item.findingId === finding.id) && (!finding.kind || finding.kind === "vulnerability") && ["critical", "high"].includes(finding.severity)).map((finding) => <li key={finding.id}>
        <span className={`vulnerability-severity severity-${finding.severity}`}>{t(`vulnerabilities.${finding.severity}`)}</span>{" "}<code>{finding.advisoryId}</code>{" · "}<code>{finding.packageName}</code>{" — "}{t(`vulnerabilities.planExcluded_${plan.excluded.find((item) => item.findingId === finding.id)!.reason}`)}
      </li>)}</ul>
    </div> : null}
    {plan.actions.length ? <ol className="vulnerability-plan-actions">{plan.actions.map((action) => <li key={action.id}>
      <strong>{t(`vulnerabilities.groupTitle_${action.kind}`).replace("{name}", localizeVulnerabilityTargetLabel(action.name, locale))}</strong>
      <p>{t(`vulnerabilities.planAction_${action.kind}`)}</p>
      <p className="vulnerability-action-strategy">{t(`vulnerabilities.planStrategy_${action.strategy}`)}</p>
      {action.reference ? <p><code>{action.reference}</code></p> : null}
      {action.kind === "dependency" ? <ul className="vulnerability-package-updates">{action.packageUpdates.map((update) => <li key={update.packageName}>
        <div><code>{update.packageName}</code>{" "}<code>{update.installedVersions.join(", ")}</code>{" → "}
          {update.recommendedVersion ? <><span>{t("vulnerabilities.planRecommendedVersion")}{" "}</span><strong><code>{update.recommendedVersion}</code></strong></>
            : update.fixedVersions.length ? <>{t("vulnerabilities.planVersionCandidates")}{" "}<code>{update.fixedVersions.join(", ")}</code></> : t("vulnerabilities.planInvestigateVersion")}
          {update.compatibility ? <span className={`vulnerability-version-change version-${update.compatibility}`}>{t(`vulnerabilities.compatibility_${update.compatibility}`)}</span> : null}
        </div>
        {update.needsVerification ? <p className="vulnerability-plan-files">{t("vulnerabilities.planVersionNeedsVerification")}</p> : null}
      </li>)}</ul> : null}
      <p className="vulnerability-plan-files">{t("vulnerabilities.planFiles")}{" "}{action.files.map((file, index) => <span key={file}>{index ? " · " : ""}<code>{file}</code></span>)}</p>
      {action.targetLabels.length ? <p className="vulnerability-plan-files">{action.targetLabels.map((label) => localizeVulnerabilityTargetLabel(label, locale)).join(" · ")}</p> : null}
    </li>)}<li><strong>{t("vulnerabilities.planVerificationTitle")}</strong><p>{t("vulnerabilities.planVerification")}</p></li></ol>
      : <p className="muted-text">{t(scanning ? "vulnerabilities.planScanRequired" : plan.phaseStatus === "complete" ? "vulnerabilities.planComplete" : "vulnerabilities.planNoActions")}</p>}
    <p className="muted-text">{t("vulnerabilities.planScopeHint")}</p>
    {plan.activeRemediationId ? <p role="status">{t("vulnerabilities.planActive")}</p> : null}
    {props.deferred && !plan.activeRemediationId ? <p className="vulnerability-plan-deferred" role="status">{t("vulnerabilities.planDeferred")}</p> : null}
    <div className="vulnerability-plan-confirmation">
      <p><strong>{t("vulnerabilities.planConfirm")}</strong></p>
      <div className="action-row">
        <button className="primary-button" disabled={props.busy || scanning || !executable || !plan.actions.length || Boolean(plan.activeRemediationId)} onClick={props.onApprove} type="button"><ShieldAlert aria-hidden="true" size={16} />{t("vulnerabilities.planApprove")}</button>
        <button className="secondary-button" disabled={props.busy || !executable || !plan.actions.length || props.deferred || Boolean(plan.activeRemediationId)} onClick={props.onDefer} type="button">{t("vulnerabilities.planDefer")}</button>
      </div>
    </div>
  </section>;
}

export function VulnerabilityTargets(props: { targets: VulnerabilityScanTarget[]; scope: VulnerabilityScope | "all"; locale?: string }) {
  const locale = props.locale ?? getLocale();
  const targets = props.targets.filter((target) => props.scope === "all" || target.scope === props.scope);
  return <details className="vulnerability-targets" aria-labelledby="vulnerability-targets-title">
    <summary><h2 id="vulnerability-targets-title">{t("vulnerabilities.targets")}</h2></summary>
    <p className="muted-text">{t("vulnerabilities.targetsHint")}</p>
    {targets.length ? <ul className="vulnerability-target-list">{targets.map((target) => <li className="vulnerability-target" key={target.id}>
      <header><strong>{localizeVulnerabilityTargetLabel(target.label, locale)}</strong><span className={`vulnerability-target-status target-${target.status}`}>{t(`vulnerabilities.targetStatus_${target.status}`)}</span></header>
      <dl>
        <div><dt>{t("vulnerabilities.target")}</dt><dd>{t(`vulnerabilities.scope_${target.scope}`)} · {localizeVulnerabilityTargetKind(target.kind, locale)}</dd></div>
        {target.ref ? <div><dt>{t("vulnerabilities.targetReference")}</dt><dd><code>{target.ref}</code></dd></div> : null}
        {target.sourcePath ? <div><dt>{t("vulnerabilities.targetSource")}</dt><dd><code>{target.sourcePath}</code></dd></div> : null}
        {target.scanner ? <div><dt>{t("vulnerabilities.targetScanner")}</dt><dd>{target.scanner}</dd></div> : null}
        <div><dt>{t("vulnerabilities.coverage")}</dt><dd>{t(`vulnerabilities.coverage_${target.coverage}`)}</dd></div>
        <div><dt>{t("vulnerabilities.dependencies")}</dt><dd>{target.dependenciesScanned}</dd></div>
        {target.checkedAt ? <div><dt>{t("vulnerabilities.lastUpdated")}</dt><dd>{formatDateTime(target.checkedAt)}</dd></div> : null}
      </dl>
      {target.diagnosis ? <div className="vulnerability-target-error"><VulnerabilityRecovery diagnosis={target.diagnosis} locale={locale} /></div>
        : target.error ? <div className="vulnerability-target-error"><strong>{t("vulnerabilities.targetError")}</strong><VulnerabilityMessage message={target.error} locale={locale} /></div> : null}
    </li>)}</ul> : <p className="muted-text">{t(props.targets.length ? "vulnerabilities.noTargetMatches" : "vulnerabilities.noTargets")}</p>}
  </details>;
}

function RemediationActivity(props: { projectId: string; remediation: VulnerabilityRemediation; onOpenAgentJob: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [jobs, setJobs] = useState<AgentJobDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (expanded) void api.getDevelopmentLoop(props.projectId, props.remediation.loopId).then((value) => {
      if (!disposed) { setJobs(value.jobs); setError(null); }
    }).catch((err) => { if (!disposed) setError(err instanceof Error ? err.message : t("vulnerabilities.loadFailed")); });
    return () => { disposed = true; };
  }, [expanded, props.projectId, props.remediation.loopId, props.remediation.updatedAt]);
  return <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{t("vulnerabilities.viewActivity")}</summary>
    {error ? <p role="alert">{error}</p> : null}
    {expanded && !jobs && !error ? <AsyncState compact kind="loading" message={t("status.loading")} /> : null}
    {jobs ? <ol className="loop-job-history">{jobs.map((job) => <li key={job.id}>
      <a href={`/jobs/${job.id}`} onClick={(event) => { event.preventDefault(); props.onOpenAgentJob(job.id); }}>#{job.id} {formatDisplayValue(job.agentType)}</a> · {formatDisplayValue(job.status)}
    </li>)}</ol> : null}
  </details>;
}

export function VulnerabilitiesView(props: { project: ProjectDto; onOpenPullRequest: (id: number) => void; onOpenAgentJob: (id: number) => void }) {
  const [dashboard, setDashboard] = useState<VulnerabilityDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [severity, setSeverity] = useState<VulnerabilitySeverity | "all">("all");
  const [scope, setScope] = useState<VulnerabilityScope | "all">("all");
  const [deferredPlan, setDeferredPlan] = useState<string | null>(null);
  const mounted = useRef(false);
  const mutationPending = useRef(false);
  const requestEpoch = useRef(0);
  const projectId = props.project.id;

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();
    async function poll() {
      let delay = 5_000;
      const epoch = requestEpoch.current;
      if (!mutationPending.current) {
        try {
          const value = await api.getVulnerabilities(projectId, controller.signal);
          if (!disposed && epoch === requestEpoch.current) {
            setDashboard(value); setError(null);
            const active = value.scan.status === "scanning" || value.remediations.some((item) => !terminalStatuses.has(item.status));
            delay = active ? 3_000 : 15_000;
          }
        } catch (err) {
          if (!disposed && epoch === requestEpoch.current) setError(err instanceof Error ? err.message : t("vulnerabilities.loadFailed"));
        }
      }
      if (!disposed) timer = window.setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { disposed = true; mounted.current = false; controller.abort(); window.clearTimeout(timer); };
  }, [projectId]);

  async function mutate(action: () => Promise<VulnerabilityDashboard>, successKey: string | ((value: VulnerabilityDashboard) => string)) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    requestEpoch.current += 1;
    setBusy(true); setError(null); setNotice(null);
    try {
      const value = await action();
      if (mounted.current) { setDashboard(value); setNotice(t(typeof successKey === "function" ? successKey(value) : successKey)); }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : t("vulnerabilities.actionFailed"));
    } finally {
      mutationPending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function approvePlan() {
    if (!dashboard) return;
    const plan = dashboard.remediationPlan ?? buildVulnerabilityRemediationPlan(dashboard);
    const previous = dashboard?.remediations ?? [];
    void mutate(() => api.remediateVulnerabilities(projectId, plan.id), (value) => {
      const changed = value.remediations.some((item) => {
        const old = previous.find((candidate) => candidate.id === item.id);
        return !old || old.status !== item.status;
      });
      return changed ? "vulnerabilities.fixRequested" : "vulnerabilities.existingFixHint";
    });
  }

  function changeSettings(input: Partial<VulnerabilitySettings>) {
    if (!dashboard || mutationPending.current) return;
    const previousSettings = dashboard.settings;
    setDashboard({ ...dashboard, settings: { ...previousSettings, ...input } });
    void mutate(async () => {
      try { return await api.updateVulnerabilitySettings(projectId, input); }
      catch (err) {
        if (mounted.current) setDashboard((current) => current ? { ...current, settings: previousSettings } : current);
        throw err;
      }
    }, "vulnerabilities.settingsSaved");
  }

  function control(remediation: VulnerabilityRemediation, action: "pause" | "resume" | "cancel") {
    void mutate(async () => {
      await api.controlDevelopmentLoop(projectId, remediation.loopId, action);
      return api.getVulnerabilities(projectId);
    }, "vulnerabilities.controlUpdated");
  }

  const open = dashboard?.findings.filter((finding) => finding.status === "open") ?? [];
  const resolved = dashboard?.findings.filter((finding) => finding.status === "resolved") ?? [];
  const matchesFilters = (finding: VulnerabilityRecord) => (severity === "all" || finding.severity === severity)
    && (scope === "all" || (finding.scope ?? "application") === scope);
  const filteredOpen = open.filter(matchesFilters);
  const filteredResolved = resolved.filter(matchesFilters);
  const visible = (status === "open" ? filteredOpen : filteredResolved)
    .sort((left, right) => severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity) || left.packageName.localeCompare(right.packageName));
  const statusFindings = status === "open" ? open : resolved;
  const plan = dashboard ? dashboard.remediationPlan ?? buildVulnerabilityRemediationPlan(dashboard) : null;
  const includedIds = new Set(plan?.findingIds);
  const excludedReasons = new Map(plan?.excluded.map((item) => [item.findingId, item.reason]));
  const scanning = dashboard?.scan.status === "scanning";
  const inventoryReady = dashboard?.scan.status === "succeeded";
  const hasActiveFix = dashboard?.remediations.some((item) => !["succeeded", "canceled"].includes(item.status));
  const filtersActive = severity !== "all" || scope !== "all";
  const emptyMessage = filtersActive ? "vulnerabilities.noMatches" : status === "resolved" ? "vulnerabilities.noResolved"
    : open.length ? "vulnerabilities.noMatches"
      : dashboard?.scan.status === "never" ? "vulnerabilities.unscanned"
        : plan?.assessment.status === "unknown" ? "vulnerabilities.assessmentUnknownEmpty"
        : dashboard?.scan.coverage === "unsupported" ? "vulnerabilities.noCoverage"
          : dashboard?.scan.coverage === "partial" ? "vulnerabilities.partialNoFindings"
          : "vulnerabilities.noFindings";

  return <section className="page-section vulnerabilities-page" aria-labelledby="vulnerabilities-title">
    <div className="section-header">
      <h1 id="vulnerabilities-title"><ShieldCheck aria-hidden="true" size={24} />{t("vulnerabilities.title")}</h1>
      <div className="action-row">
        <button className="secondary-button" disabled={!dashboard || busy || scanning} onClick={() => void mutate(() => api.refreshVulnerabilities(projectId), "vulnerabilities.refreshRequested")} type="button"><RefreshCw aria-hidden="true" className={scanning ? "async-state-spinner" : undefined} size={16} />{t(scanning ? "vulnerabilities.refreshing" : "vulnerabilities.refresh")}</button>
      </div>
    </div>
    <p className="muted-text">{t("vulnerabilities.description")}</p>
    {/^ja(?:-|$)/i.test(props.project.locale) ? <p className="muted-text">{t("vulnerabilities.translationNote")}</p> : null}
    {error ? <div className="error-banner" role="alert"><VulnerabilityMessage message={error} locale={props.project.locale} /></div> : null}
    <p className="vulnerability-notice" role="status">{notice}</p>
    {!dashboard && !error ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
    {dashboard ? <>
      <div className="vulnerability-settings">
        <div className="vulnerability-settings-controls">
          <label><input checked={dashboard.settings.autoRefresh} disabled={busy} onChange={(event) => changeSettings({ autoRefresh: event.target.checked })} type="checkbox" />{t("vulnerabilities.automaticUpdates")}</label>
          <label>{t("vulnerabilities.interval")}<select disabled={busy || !dashboard.settings.autoRefresh} onChange={(event) => changeSettings({ intervalHours: Number(event.target.value) })} value={dashboard.settings.intervalHours}>
            <option value={12}>{t("vulnerabilities.twiceDaily")}</option><option value={24}>{t("vulnerabilities.daily")}</option><option value={168}>{t("vulnerabilities.weekly")}</option>
            {![12, 24, 168].includes(dashboard.settings.intervalHours) ? <option value={dashboard.settings.intervalHours}>{dashboard.settings.intervalHours} {t("vulnerabilities.hours")}</option> : null}
          </select></label>
        </div>
        <p className="muted-text">{t("vulnerabilities.runningHint")}</p>
        <p className="muted-text">{t("vulnerabilities.coverageHint")}</p>
      </div>
      <dl className="vulnerability-scan-facts" aria-live="polite">
        <div><dt>{t("vulnerabilities.scanStatus")}</dt><dd>{t(`vulnerabilities.scan_${dashboard.scan.status}`)}</dd></div>
        <div><dt>{t("vulnerabilities.lastUpdated")}</dt><dd>{dashboard.scan.completedAt ? formatDateTime(dashboard.scan.completedAt) : t("vulnerabilities.never")}</dd></div>
        <div><dt>{t("vulnerabilities.nextUpdate")}</dt><dd>{dashboard.settings.autoRefresh ? formatDateTime(dashboard.scan.nextScanAt) : t("vulnerabilities.disabled")}</dd></div>
        <div><dt>{t("vulnerabilities.dependencies")}</dt><dd>{dashboard.scan.dependenciesScanned}</dd></div>
      </dl>
      {dashboard.scan.error ? <div className="error-banner" role="alert"><strong>{t("vulnerabilities.scanFailed")}</strong><VulnerabilityMessage message={dashboard.scan.error} locale={props.project.locale} /></div> : null}
      {dashboard.scan.status !== "never" || dashboard.scan.warnings.length ? <details className={`vulnerability-coverage coverage-${dashboard.scan.coverage}`} open={dashboard.scan.coverage !== "complete"}>
        <summary>{t("vulnerabilities.warnings")} · {t(`vulnerabilities.coverage_${dashboard.scan.coverage}`)}</summary>
        {dashboard.scan.warnings.length ? <p>{t("vulnerabilities.coverageManual")}</p> : null}
        {dashboard.scan.warnings.length ? <ul>{dashboard.scan.warnings.map((warning, index) => <li key={index}><VulnerabilityMessage message={warning} locale={props.project.locale} /></li>)}</ul> : null}
        {dashboard.scan.recoveries?.length ? <details className="vulnerability-recovery-history"><summary>{t("vulnerabilities.recoveryHistory")}</summary>{dashboard.scan.recoveries.map((diagnosis, index) => <VulnerabilityRecovery key={`${diagnosis.fingerprint}:${index}`} diagnosis={diagnosis} locale={props.project.locale} />)}</details> : null}
        {dashboard.scan.manifests.length ? <><strong>{t("vulnerabilities.manifests")}</strong><ul>{dashboard.scan.manifests.map((path) => <li key={path}><code>{path}</code></li>)}</ul></> : null}
      </details> : null}
      {(!inventoryReady || dashboard.scan.coverage !== "complete") && dashboard.scan.status !== "never" ? <p className="muted-text vulnerability-response-hint">{t("vulnerabilities.completeScanRequired")}</p> : null}
      {hasActiveFix ? <p className="muted-text vulnerability-response-hint">{t("vulnerabilities.existingFixHint")}</p> : null}
      <div className="vulnerability-summary" aria-label={t("vulnerabilities.title")}>
        <div><strong>{open.length}</strong><span>{t("vulnerabilities.open")}</span></div>
        <div><strong className="vulnerability-critical-count">{open.filter((finding) => finding.severity === "critical").length}</strong><span>{t("vulnerabilities.critical")}</span></div>
        <div><strong>{open.filter((finding) => finding.severity === "high").length}</strong><span>{t("vulnerabilities.high")}</span></div>
        <div><strong>{resolved.length}</strong><span>{t("vulnerabilities.resolved")}</span></div>
      </div>
      <VulnerabilityPlan dashboard={dashboard} busy={busy} locale={props.project.locale} deferred={deferredPlan === plan?.id} onApprove={approvePlan} onDefer={() => setDeferredPlan(plan!.id)} />
      <section className="vulnerability-results" aria-labelledby="vulnerability-results-title">
        <div className="vulnerability-results-header">
          <h2 id="vulnerability-results-title">{t("vulnerabilities.results")}</h2>
        </div>
        <div className="vulnerability-filters">
          <div className="vulnerability-status-filters" role="group" aria-label={t("vulnerabilities.statusFilter")}>
            <button aria-pressed={status === "open"} className={status === "open" ? "active" : ""} onClick={() => setStatus("open")} type="button">{t("vulnerabilities.open")} ({filteredOpen.length})</button>
            <button aria-pressed={status === "resolved"} className={status === "resolved" ? "active" : ""} onClick={() => setStatus("resolved")} type="button">{t("vulnerabilities.resolved")} ({filteredResolved.length})</button>
          </div>
          <div className="vulnerability-filter-selects">
            <select aria-label={t("vulnerabilities.scopeFilter")} onChange={(event) => setScope(event.target.value as VulnerabilityScope | "all")} value={scope}>
              <option value="all">{t("vulnerabilities.allScopes")}</option>{scopes.map((value) => <option key={value} value={value}>{t(`vulnerabilities.scope_${value}`)}</option>)}
            </select>
            <select aria-label={t("vulnerabilities.severityFilter")} onChange={(event) => setSeverity(event.target.value as VulnerabilitySeverity | "all")} value={severity}>
              <option value="all">{t("vulnerabilities.allSeverities")}</option>{severityOrder.map((value) => <option key={value} value={value}>{t(`vulnerabilities.${value}`)}</option>)}
            </select>
            {filtersActive ? <button className="secondary-button" onClick={() => { setSeverity("all"); setScope("all"); }} type="button">{t("vulnerabilities.resetFilters")}</button> : null}
          </div>
        </div>
        <p className="vulnerability-result-count muted-text" role="status">{t("vulnerabilities.showingResults").replace("{count}", String(visible.length)).replace("{total}", String(status === "open" ? open.length : resolved.length))}</p>
        {status === "open" ? <div className="vulnerability-plan-lists">
          {(["included", "excluded"] as const).map((disposition) => {
            const allFindings = open.filter((finding) => includedIds.has(finding.id) === (disposition === "included"));
            const findings = visible.filter((finding) => includedIds.has(finding.id) === (disposition === "included"));
            return <section className={`vulnerability-plan-${disposition}`} data-testid={`vulnerability-plan-${disposition}`} key={disposition} aria-labelledby={`vulnerability-${disposition}-title`}>
              <h3 id={`vulnerability-${disposition}-title`}>{t(disposition === "included" ? "vulnerabilities.planIncludedTitle" : "vulnerabilities.planExcludedTitle")} ({allFindings.length})</h3>
              <p className="muted-text">{t(disposition === "included" ? "vulnerabilities.planIncludedHint" : "vulnerabilities.planExcludedHint")}</p>
              {findings.length ? <VulnerabilityGroups findings={findings} allFindings={allFindings} remediations={dashboard.remediations} scan={dashboard.scan} locale={props.project.locale} planDisposition={disposition} exclusionReasons={excludedReasons} onOpenPullRequest={props.onOpenPullRequest} />
                : <p className="muted-text">{t(filtersActive && allFindings.length ? "vulnerabilities.noMatches" : disposition === "included" ? "vulnerabilities.planNoIncluded" : "vulnerabilities.planNoExcluded")}</p>}
            </section>;
          })}
          {!open.length ? <AsyncState kind={scanning ? "loading" : dashboard.scan.status === "failed" ? "error" : "empty"} message={scanning ? t("vulnerabilities.refreshing") : dashboard.scan.status === "failed" ? t("vulnerabilities.scanFailed") : t(emptyMessage)} /> : null}
        </div> : visible.length ? <VulnerabilityGroups findings={visible} allFindings={statusFindings} remediations={dashboard.remediations} scan={dashboard.scan} locale={props.project.locale} onOpenPullRequest={props.onOpenPullRequest} />
          : <AsyncState kind={filtersActive || status === "resolved" ? "empty" : scanning ? "loading" : dashboard.scan.status === "failed" ? "error" : "empty"} message={filtersActive || status === "resolved" ? t(emptyMessage) : scanning ? t("vulnerabilities.refreshing") : dashboard.scan.status === "failed" ? t("vulnerabilities.scanFailed") : t(emptyMessage)} />}
      </section>
      {dashboard.scan.targets ? <VulnerabilityTargets targets={dashboard.scan.targets} scope={scope} locale={props.project.locale} /> : null}
      <section className="vulnerability-remediations" aria-labelledby="vulnerability-remediations-title">
        <h2 id="vulnerability-remediations-title">{t("vulnerabilities.remediate")}</h2>
        {!dashboard.remediations.length ? <p className="muted-text">{t("vulnerabilities.noRemediations")}</p> : null}
        {dashboard.remediations.map((remediation) => {
          const terminal = remediation.status === "succeeded" || remediation.status === "canceled";
          const needsResume = ["paused", "failed", "waiting_input"].includes(remediation.status);
          const merging = remediation.status === "running" && remediation.phase === "merging";
          const stillOpen = remediation.findingIds.some((id) => open.some((finding) => finding.id === id));
          return <article className="vulnerability-remediation" key={remediation.id}>
            <header><strong>{t("vulnerabilities.remediation")} #{remediation.loopId}</strong><span className={`status-pill status-${remediation.status}`}>{t(`development.${remediation.status}`)}</span><span>{t(remediation.phase === "completed" ? "vulnerabilities.completed" : `development.${remediation.phase}`)}</span><time dateTime={remediation.updatedAt}>{formatDateTime(remediation.updatedAt)}</time></header>
            {remediation.summary ? <p className="loop-summary">{remediation.summary}</p> : null}
            <p className="vulnerability-remediation-packages">{[...new Set(dashboard.findings.filter((finding) => remediation.findingIds.includes(finding.id)).map((finding) => finding.packageName))].join(", ")}</p>
            {remediation.status === "succeeded" && stillOpen ? <p className="muted-text">{t("vulnerabilities.awaitingConfirmation")}</p> : null}
            <div className="action-row">
              {remediation.pullRequestId ? <a className="secondary-button" href={`/pulls/${remediation.pullRequestId}`} onClick={(event) => { event.preventDefault(); props.onOpenPullRequest(remediation.pullRequestId!); }}><GitPullRequest aria-hidden="true" size={15} />{t("vulnerabilities.viewPullRequest")} #{remediation.pullRequestId}</a> : null}
              {!terminal ? <>
                <button className="secondary-button" disabled={busy || merging} onClick={() => control(remediation, needsResume ? "resume" : "pause")} type="button">{t(`vulnerabilities.${needsResume ? "resume" : "pause"}`)}</button>
                <button className="danger-button" disabled={busy || merging} onClick={() => control(remediation, "cancel")} type="button">{t("vulnerabilities.cancel")}</button>
              </> : null}
            </div>
            <RemediationActivity projectId={projectId} remediation={remediation} onOpenAgentJob={props.onOpenAgentJob} />
          </article>;
        })}
      </section>
    </> : null}
  </section>;
}
