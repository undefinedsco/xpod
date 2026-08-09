import { useEffect, useState, type FormEvent } from 'react';
import { AiConfigForm } from './ModelAssignmentsPanel';
import { useAiConfig } from './AiConfigContext';
import { isPolicyValueDirty } from './form-state';

export function DocumentProcessingPanel() {
  const { config, save, saving } = useAiConfig();
  const [value, setValue] = useState(config?.documentProcessing);
  useEffect(() => setValue(config?.documentProcessing), [config]);
  if (!value) return null;
  const dirty = isPolicyValueDirty(value, config?.documentProcessing);
  const submit = async (event: FormEvent) => { event.preventDefault(); await save({ documentProcessing: value }); };
  return (
    <AiConfigForm title="Document Processing" description="Control when Xpod invokes OCR and structured document readers." onSubmit={submit} onRestore={() => save({ documentProcessing: { ocrEnabled: true, automaticOcr: true, imageRecognition: true, pdfRecognition: true, tableRecognition: false, processingMode: 'auto', ocrFallbackOrder: ['ocr', 'reader', 'plain-text'], readerPolicy: 'auto', readerPriority: 'structure-first', maxFileSizeMb: 64, maxPages: 500, failureFallback: 'plain-text' } })} saving={saving} dirty={dirty}>
      <div className="space-y-4 rounded-xl border border-border p-4">
        <Toggle label="Enable OCR" description="Read text from images and scanned documents." checked={value.ocrEnabled} onChange={(checked) => setValue({ ...value, ocrEnabled: checked })} />
        <Toggle label="Automatic OCR" description="Run OCR when indexed content has no usable text layer." checked={value.automaticOcr} onChange={(checked) => setValue({ ...value, automaticOcr: checked })} />
        <Toggle label="Image recognition" description="Allow OCR and readers to process image resources." checked={value.imageRecognition} onChange={(checked) => setValue({ ...value, imageRecognition: checked })} />
        <Toggle label="PDF recognition" description="Process native and scanned PDF resources." checked={value.pdfRecognition} onChange={(checked) => setValue({ ...value, pdfRecognition: checked })} />
        <Toggle label="Table recognition" description="Preserve detected table structure when the reader supports it." checked={value.tableRecognition} onChange={(checked) => setValue({ ...value, tableRecognition: checked })} />
        <label className="block space-y-2 text-sm font-medium">
          Processing mode
          <select name="processingMode" value={value.processingMode} onChange={(event) => setValue({ ...value, processingMode: event.target.value as 'auto' | 'on-demand' })} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:max-w-xs">
            <option value="auto">Auto</option>
            <option value="on-demand">On demand</option>
          </select>
        </label>
        <label className="block space-y-2 text-sm font-medium">OCR fallback order
          <input value={value.ocrFallbackOrder.join(', ')} onChange={(event) => setValue({ ...value, ocrFallbackOrder: event.target.value.split(',').map((item) => item.trim()).filter((item): item is 'ocr' | 'reader' | 'plain-text' => ['ocr', 'reader', 'plain-text'].includes(item)) })} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Reader policy" value={value.readerPolicy} options={['auto', 'always', 'disabled']} onChange={(readerPolicy) => setValue({ ...value, readerPolicy: readerPolicy as typeof value.readerPolicy })} />
          <SelectField label="Reader priority" value={value.readerPriority} options={['structure-first', 'speed-first']} onChange={(readerPriority) => setValue({ ...value, readerPriority: readerPriority as typeof value.readerPriority })} />
          <NumberField label="Maximum file size (MB)" value={value.maxFileSizeMb} min={1} max={1024} onChange={(maxFileSizeMb) => setValue({ ...value, maxFileSizeMb })} />
          <NumberField label="Maximum pages" value={value.maxPages} min={1} max={10000} onChange={(maxPages) => setValue({ ...value, maxPages })} />
          <SelectField label="Failure fallback" value={value.failureFallback} options={['plain-text', 'skip']} onChange={(failureFallback) => setValue({ ...value, failureFallback: failureFallback as typeof value.failureFallback })} />
        </div>
      </div>
    </AiConfigForm>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange(value: string): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm">{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>; }
function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange(value: number): void }) { return <label className="block space-y-2 text-sm font-medium">{label}<input type="number" value={value} min={min} max={max} onChange={(event) => onChange(event.target.valueAsNumber)} className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm" /></label>; }

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(checked: boolean): void }) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 rounded border-input" />
    </label>
  );
}
