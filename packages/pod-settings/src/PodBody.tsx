import { useState } from 'react';
import { Badge, Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, FormField, NativeSelect, SectionHeader, SettingRow } from '@undefineds.co/shared-ui';
import type { PodBodyProps, PodToggle } from './contract';

const row = 'flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-border py-3';
const jobLabels = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败' };
const modelStatusLabels = { loading: '正在读取模型…', available: 'Xpod 管理', empty: '已连接 Xpod，暂无模型', unauthorized: '请登录并允许 Xpod 访问', error: '模型读取失败，请重试', unavailable: '当前模型暂不可用' };

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
  const toggles = (items: PodToggle[]) => items.map(item => (
    <SettingRow
      key={item.id}
      label={item.label}
      description={item.description}
      control={(controlProps) => (
        <Checkbox {...controlProps} checked={item.checked} disabled={busy} onChange={e => void run(() => props.onToggle(item.id, e.target.checked))} />
      )}
    />
  ));
  return <Dialog open={changeEmbedding} onOpenChange={open => { if (!busy) setChangeEmbedding(open); }}><div className="mx-auto max-w-4xl space-y-6 p-6">
    {(notice || props.error) && <p role="status" className="text-sm leading-normal">{props.error ? 'Pod 设置暂时无法保存，请重试。' : notice}</p>}
    {props.section === 'models' && <section aria-label="默认模型">
      <p className="text-sm leading-normal text-muted-foreground">应用没有指定模型时用这里的默认值，随时可以改。</p>
      {Array.from(new Set(props.models.map(model => model.group))).map(group => <section key={group} className="mt-5">
        <SectionHeader level={2} title={group} titleClassName="text-xs leading-normal text-muted-foreground" />
        {props.models.filter(model => model.group === group).map(model => <div key={model.id} className={row}>
          <label htmlFor={`pod-model-${model.id}`} className="min-w-28 text-sm leading-normal">{model.label}</label>
          {model.id === 'embeddingModel' ? <><span className="flex-1 text-sm leading-normal">{props.embeddingLabel}</span><Button variant="outline" size="sm" onClick={() => props.onSection('search')}>去更换 ›</Button></> : model.models ? <>
            <NativeSelect id={`pod-model-${model.id}`} className="min-w-[10ch] flex-1" value={model.value ?? ''} disabled={busy} onChange={e => void run(() => props.onModel(model.id, e.target.value))}>
              <option value="">{model.defaultLabel}</option>
              {model.value && !model.models.some(candidate => candidate.ref === model.value) && <option value={model.value}>当前模型（暂不可用）</option>}
              {model.models.map(option => <option key={option.ref} value={option.ref}>{option.label}</option>)}
            </NativeSelect>
            {model.models.length === 0 && props.freeQuotaUrl && <a href={props.freeQuotaUrl} className="text-sm leading-normal text-primary">领免费额度 ›</a>}
          </> : <><span className="flex-1 text-sm leading-normal text-muted-foreground">{model.defaultLabel}</span>{!model.supported && <Pending />}</>}
          {model.status && (model.models || model.supported) && <span className="text-xs leading-normal text-muted-foreground">{modelStatusLabels[model.status]}</span>}
          {model.id !== 'embeddingModel' && model.testable && <Button variant="outline" size="sm" disabled={busy || !(model.testValue ?? model.value)} onClick={() => void run(() => props.onTest(model.id, (model.testValue ?? model.value)!), '测试通过')}>测试</Button>}
        </div>)}
      </section>)}
    </section>}
    {props.section === 'search' && <>
      <section aria-label="检索">{toggles(props.search)}<div className={row}><span className="text-sm leading-normal">语义检索用的 Embedding<br/><span className="text-xs leading-normal text-muted-foreground">{props.embeddingLabel}</span></span><DialogTrigger asChild><Button variant="outline" size="sm" disabled={busy || !props.canChangeEmbedding} onClick={() => { setEmbedding(''); setSource('platform'); }}>更换</Button></DialogTrigger></div></section>
      <section aria-label="索引"><SectionHeader level={2} title="索引" titleClassName="font-semibold" description={<>待处理 {props.pending ?? 0} · 配置版本 {props.version ?? '默认'}</>} actions={<><NativeSelect aria-label="重建哪部分" className="min-w-[10ch] w-auto" value={target} onChange={e => setTarget(e.target.value as typeof target)}><option value="all">重建全部</option><option value="fts">只重建全文</option><option value="vector">只重建向量</option></NativeSelect><Button variant="outline" size="sm" disabled={busy || !props.rebuildTargets.includes(target)} onClick={() => void run(() => props.onRebuild(target), '重建已排队')}>重建</Button></>} />
        {props.jobs.length ? props.jobs.map(job => <div key={job.id} className={row}><span className="text-sm leading-normal">{job.label}</span><span className="text-sm leading-normal">{jobLabels[job.status]}{job.progress === undefined ? '' : ` · ${job.progress}%`}</span></div>) : <p className="py-4 text-sm leading-normal text-muted-foreground">还没有重建记录</p>}
        {toggles(props.maintenance)}<p className="mt-3 text-xs leading-normal text-muted-foreground">重建只重算索引，不改动 Pod 里的原始资料。</p>
      </section>
      {props.error?.includes('service_access_missing') && <Button variant="outline" size="sm" disabled={busy || props.backgroundAccess.busy} onClick={() => void run(props.onGrant, '已允许 Xpod 访问')}>允许 Xpod 访问</Button>}
    </>}
    {props.section === 'apps' && <section aria-label="授权应用"><p className="text-sm leading-normal text-muted-foreground">哪些应用和服务能读写这个 Pod。</p><div className={row}><details className="flex-1"><summary className="cursor-pointer text-sm leading-normal font-medium">Xpod 后台访问 · {props.backgroundAccess.loading ? '读取中' : props.backgroundAccess.granted ? '已授权' : '未授权'}</summary><p className="py-3 text-xs leading-normal text-muted-foreground">用于索引维护和后台任务。流量与访问记录：待接入。</p></details>{props.backgroundAccess.granted ? <details><summary aria-label="Xpod 后台访问的更多操作" className="cursor-pointer p-2">⋯</summary><span className="block py-2 text-xs leading-normal text-muted-foreground">修改权限 · 待接入</span><Button variant="outline" size="sm" disabled={busy || props.backgroundAccess.busy} onClick={() => void run(props.onRevoke, '已撤销授权')}>撤销</Button></details> : <Button variant="outline" size="sm" disabled={busy || props.backgroundAccess.busy || props.backgroundAccess.loading} onClick={() => void run(props.onGrant, '已允许 Xpod 访问')}>允许</Button>}</div>{props.backgroundAccess.error && <p role="alert" className="text-sm leading-normal">授权操作暂时不可用，请重试。</p>}<p className="mt-4 text-xs leading-normal text-muted-foreground">其他授权应用 · 待接入</p></section>}
    {props.section === 'data' && <><section aria-label="用量"><SectionHeader level={2} title="用量" titleClassName="font-semibold" /><div className="mt-3 grid grid-cols-2 gap-3">{props.usage.map(item => <div key={item.label} className="rounded-xl border border-border p-4"><span className="block text-xs leading-normal text-muted-foreground">{item.label}</span><span className="mt-2 block text-sm leading-normal">{item.value}</span></div>)}</div></section><section aria-label="数据管理">{['导入', '导出', '迁移'].map(label => <div key={label} className={row}><span className="text-sm leading-normal">{label}</span><Pending />{label === '迁移' && props.accountUrl && <a className="inline-flex min-h-9 items-center text-sm leading-normal text-primary" href={props.accountUrl}>管理账号 ↗</a>}</div>)}</section></>}
    <DialogContent closeLabel="关闭" closeDisabled={busy} className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>更换语义检索模型</DialogTitle></DialogHeader>
      <FormField label="来源">{field => <NativeSelect {...field} value={source} disabled={busy} onChange={event => { setSource(event.target.value as typeof source); setEmbedding(''); }}><option value="platform">Xpod 提供</option><option value="own">用我自己的 Key</option></NativeSelect>}</FormField>
      <FormField label="模型">{field => <NativeSelect {...field} value={embedding} disabled={busy} onChange={event => setEmbedding(event.target.value)}><option value="">请选择</option>{props.embeddingModels.filter(model => model.source === source).map(model => <option key={model.ref} value={model.ref}>{model.label}</option>)}</NativeSelect>}</FormField>
      {!props.embeddingModels.some(model => model.source === source) && <p className="text-xs leading-normal text-muted-foreground">{source === 'platform' ? 'Xpod 提供的模型目录 · 待接入' : '暂无可用向量模型，请先在 AI 连接中添加。'}</p>}
      <DialogDescription>更换后会重建全部语义索引，重建期间只能全文检索。</DialogDescription>
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setChangeEmbedding(false)}>取消</Button>
        <Button disabled={busy || !props.canChangeEmbedding || !props.embeddingModels.some(model => model.ref === embedding && model.source === source)} onClick={() => void run(async () => { await props.onEmbedding(embedding); setChangeEmbedding(false); }, '更换已保存，重建已排队')}>更换并重建索引</Button>
      </DialogFooter>
    </DialogContent>
  </div></Dialog>;
}
function Pending() { return <Badge variant="pending" className="font-normal">待接入</Badge>; }
