import { useState } from 'react';
import type { PodBodyProps, PodToggle } from './contract';

const button = 'min-h-9 py-1 rounded-lg border border-border px-3 text-sm leading-normal disabled:opacity-50';
const row = 'flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border py-3';
const jobLabels = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败' };

/** Identical body for desktop and LinX; the host provides navigation and authenticated operations. */
export function PodBody(props: PodBodyProps) {
  const [changeEmbedding, setChangeEmbedding] = useState(false);
  const [source, setSource] = useState<'platform' | 'own'>('platform');
  const [embedding, setEmbedding] = useState('');
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);
  const [target, setTarget] = useState<'all' | 'fts' | 'vector'>('all');
  const run = async (action: () => Promise<void>, success = '已保存') => {
    setWorking(true);
    setNotice(undefined);
    try { await action(); setNotice(success); } catch { setNotice('操作未完成，请重试。'); } finally { setWorking(false); }
  };
  const busy = props.busy || working;
  const toggles = (items: PodToggle[]) => items.map(item => <label key={item.id} className={row}>
    <span><span className="block text-sm leading-normal font-medium">{item.label}</span>{item.description && <span className="block text-xs leading-normal text-muted-foreground">{item.description}</span>}</span>
    <input type="checkbox" checked={item.checked} disabled={busy} onChange={e => void run(() => props.onToggle(item.id, e.target.checked))} />
  </label>);
  return <div className="mx-auto max-w-4xl space-y-6 p-6">
    {(notice || props.error) && <p role="status" className="text-sm leading-normal">{props.error ? 'Pod 设置暂时无法保存，请重试。' : notice}</p>}
    {props.section === 'models' && <section aria-label="默认模型">
      <p className="text-sm leading-normal text-muted-foreground">应用没有指定模型时用这里的默认值，随时可以改。</p>
      {Array.from(new Set(props.models.map(model => model.group))).map(group => <section key={group} className="mt-5">
        <h2 className="text-xs leading-normal text-muted-foreground">{group}</h2>
        {props.models.filter(model => model.group === group).map(model => <div key={model.id} className={row}>
          <label htmlFor={`pod-model-${model.id}`} className="min-w-28 text-sm leading-normal">{model.label}</label>
          {model.id === 'embeddingModel' ? <><span className="flex-1 text-sm leading-normal">{props.embeddingLabel}</span><button className={button} onClick={() => props.onSection('search')}>去更换 ›</button></> : model.models ? <>
            <select id={`pod-model-${model.id}`} className="h-auto min-h-9 min-w-[10ch] flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm leading-normal" value={model.value ?? ''} disabled={busy} onChange={e => void run(() => props.onModel(model.id, e.target.value))}>
              <option value="">{model.defaultLabel}</option>
              {model.value && !model.models.some(candidate => candidate.ref === model.value) && <option value={model.value}>当前模型（暂不可用）</option>}
              {model.models.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            </select>
            {model.testable ? <button className={button} disabled={busy || !model.value} onClick={() => void run(() => props.onTest(model.id, model.value!), '测试通过')}>测试</button> : <Pending />}
            {model.models.length === 0 && props.freeQuotaUrl && <a href={props.freeQuotaUrl} className="text-sm leading-normal text-primary">领免费额度 ›</a>}
          </> : <><span className="flex-1 text-sm leading-normal text-muted-foreground">{model.defaultLabel}</span><Pending /></>}
        </div>)}
      </section>)}
    </section>}
    {props.section === 'search' && <>
      <section aria-label="检索">{toggles(props.search)}<div className={row}><span className="text-sm leading-normal">语义检索用的 Embedding<br/><span className="text-xs leading-normal text-muted-foreground">{props.embeddingLabel}</span></span><button className={button} disabled={busy || !props.canChangeEmbedding} onClick={() => { setEmbedding(''); setSource('platform'); setChangeEmbedding(true); }}>更换</button></div></section>
      <section aria-label="索引"><div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto text-sm leading-normal font-semibold">索引</h2><span className="text-xs leading-normal text-muted-foreground">待处理 {props.pending ?? 0} · 配置版本 {props.version ?? '默认'}</span><select aria-label="重建哪部分" className={button} value={target} onChange={e => setTarget(e.target.value as typeof target)}><option value="all">重建全部</option><option value="fts">只重建全文</option><option value="vector">只重建向量</option></select><button className={button} disabled={busy || !props.rebuildTargets.includes(target)} onClick={() => void run(() => props.onRebuild(target), '重建已排队')}>重建</button></div>
        {props.jobs.length ? props.jobs.map(job => <div key={job.id} className={row}><span className="text-sm leading-normal">{job.label}</span><span className="text-sm leading-normal">{jobLabels[job.status]}{job.progress === undefined ? '' : ` · ${job.progress}%`}</span></div>) : <p className="py-4 text-sm leading-normal text-muted-foreground">还没有重建记录</p>}
        {toggles(props.maintenance)}<p className="mt-3 text-xs leading-normal text-muted-foreground">重建只重算索引，不改动 Pod 里的原始资料。</p>
      </section>
      {props.error?.includes('service_access_missing') && <button className={button} disabled={busy || props.backgroundAccess.busy} onClick={() => void run(props.onGrant, '已允许 Xpod 访问')}>允许 Xpod 访问</button>}
    </>}
    {props.section === 'apps' && <section aria-label="授权应用"><p className="text-sm leading-normal text-muted-foreground">哪些应用和服务能读写这个 Pod。</p><div className={row}><details className="flex-1"><summary className="cursor-pointer text-sm leading-normal font-medium">Xpod 后台访问 · {props.backgroundAccess.loading ? '读取中' : props.backgroundAccess.granted ? '已授权' : '未授权'}</summary><p className="py-3 text-xs leading-normal text-muted-foreground">用于索引维护和后台任务。流量与访问记录：待接入。</p></details>{props.backgroundAccess.granted ? <details><summary aria-label="Xpod 后台访问的更多操作" className="cursor-pointer p-2">⋯</summary><span className="block py-2 text-xs leading-normal text-muted-foreground">修改权限 · 待接入</span><button className={button} disabled={busy || props.backgroundAccess.busy} onClick={() => void run(props.onRevoke, '已撤销授权')}>撤销</button></details> : <button className={button} disabled={busy || props.backgroundAccess.busy || props.backgroundAccess.loading} onClick={() => void run(props.onGrant, '已允许 Xpod 访问')}>允许</button>}</div>{props.backgroundAccess.error && <p role="alert" className="text-sm leading-normal">授权操作暂时不可用，请重试。</p>}<p className="mt-4 text-xs leading-normal text-muted-foreground">其他授权应用 · 待接入</p></section>}
    {props.section === 'data' && <><section aria-label="用量"><h2 className="text-sm leading-normal font-semibold">用量</h2><div className="mt-3 grid grid-cols-2 gap-3">{props.usage.map(item => <div key={item.label} className="rounded-xl border border-border p-4"><span className="block text-xs leading-normal text-muted-foreground">{item.label}</span><span className="mt-2 block text-sm leading-normal">{item.value}</span></div>)}</div></section><section aria-label="数据管理">{['导入', '导出', '迁移'].map(label => <div key={label} className={row}><span className="text-sm leading-normal">{label}</span><Pending />{label === '迁移' && props.accountUrl && <a className="text-sm leading-normal text-primary" href={props.accountUrl}>管理账号 ↗</a>}</div>)}</section></>}
    {changeEmbedding && <div role="dialog" aria-modal="true" aria-label="更换语义检索模型" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onKeyDown={event => { if (event.key === 'Escape' && !busy) setChangeEmbedding(false); if (event.key === 'Tab') { const elements = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)'); const first = elements[0]; const last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}><section className="w-full max-w-lg space-y-4 rounded-xl border border-border bg-background p-6"><h2 className="text-base leading-normal font-semibold">更换语义检索模型</h2><label className="block text-sm leading-normal">来源<select autoFocus className={`mt-2 w-full ${button}`} value={source} onChange={e => { setSource(e.target.value as typeof source); setEmbedding(''); }}><option value="platform">Xpod 提供</option><option value="own">用我自己的 Key</option></select></label><label className="block text-sm leading-normal">模型<select className={`mt-2 w-full ${button}`} value={embedding} onChange={e => setEmbedding(e.target.value)}><option value="">请选择</option>{props.embeddingModels.filter(model => model.source === source).map(model => <option key={model.ref} value={model.ref}>{model.label}</option>)}</select></label>{!props.embeddingModels.some(model => model.source === source) && <p className="text-xs leading-normal text-muted-foreground">{source === 'platform' ? 'Xpod 提供的模型目录 · 待接入' : '暂无可用向量模型，请先在 AI 连接中添加。'}</p>}<p className="text-sm leading-normal">更换后会重建全部语义索引，重建期间只能全文检索。</p><div className="flex justify-end gap-2"><button className={button} disabled={busy} onClick={() => setChangeEmbedding(false)}>取消</button><button className={`${button} bg-primary text-primary-foreground`} disabled={busy || !embedding} onClick={() => void run(async () => { await props.onEmbedding(embedding); setChangeEmbedding(false); }, '更换已保存，重建已排队')}>更换并重建索引</button></div></section></div>}
  </div>;
}
function Pending() { return <span className="rounded-md border border-dashed border-border px-2 py-1 text-xs leading-normal text-muted-foreground">待接入</span>; }
