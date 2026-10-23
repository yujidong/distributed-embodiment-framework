/**
 * ImportWizards — UX-W3/W5 create-dialog lanes: 图纸 (floorplan, vision-LLM)
 * / IFC / OSM / 一句话 (NL, text-LLM). Each pane is a two-step wizard:
 * collect inputs → call the draft lane (never persists) → hand the draft to
 * the shared ImportDraftReview → confirm posts the edited draft to
 * POST /api/environments.
 *
 * Lane-specific failure postures (all honest, none silent):
 * - floorplan 503 FLOORPLAN_VISION_UNAVAILABLE → a teaching state that names
 *   the missing vision LLM and offers the no-LLM IFC / OSM lanes;
 * - floorplan 400 with an LLM-read scale suggestion embedded in the message
 *   →「采用 N px/m 并重试」chip (the server never applies it silently);
 * - IFC 422 / OSM 404 / OSM 503 → the localized error stays inline;
 * - NL 503 NL_IMPORT_UNAVAILABLE → teaching state pointing at the LLM-free
 *   lanes; NL 422 NL_IMPORT_NO_BUILDING → the server's example phrasings
 *   stay inline in the error.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import * as api from '../api/client';
import { ApiClientError } from '../api/client';
import type { EnvVisibility, ScenarioImportDraft } from '../api/types';
import { parseScaleSuggestionFromMessage } from '../lib/importDraft';
import { queryKeys } from '../lib/queryClient';
import { useAppStore } from '../store/useAppStore';
import { FilePickButton } from './ui/FilePickButton';
import { ImportDraftReview } from './ImportDraftReview';

export interface ImportWizardPaneProps {
  visibility: EnvVisibility;
  membersPlan: boolean;
  onClose: () => void;
  /** 503 teaching state: jump to a no-LLM lane. */
  onSwitchMode: (mode: 'ifc' | 'osm') => void;
}

/** Shared confirm step: POST the reviewed draft, toast warnings, navigate. */
function useCreateFromDraft(onClose: () => void) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useAppStore(s => s.pushToast);
  const { t } = useTranslation('environments');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createFromDraft = async (
    draft: Record<string, unknown>,
    extras: { visibility: EnvVisibility; membersPlan: boolean },
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const detail = await api.createEnvironment({
        ...draft,
        visibility: extras.visibility,
        ...(extras.membersPlan ? ({ ownershipPlan: 'members' } as const) : {}),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
      for (const warning of detail.warnings ?? []) pushToast(warning);
      onClose();
      navigate(`/environments/${detail.id}`);
    } catch (err) {
      // Surface the server's `issues` array (e.g. which zone a dangling
      // adjacency points at) — without it the user cannot self-serve the fix
      // (ux-w3 probe P3).
      const issuesText = err instanceof ApiClientError && Array.isArray(err.issues) && err.issues.length > 0
        ? `\n${(err.issues as unknown[]).slice(0, 5).map(issue => `· ${String(issue)}`).join('\n')}`
        : '';
      setError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}${issuesText}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return { createFromDraft, createBusy: busy, createError: error };
}

/** File → base64 (+ mimeType) via FileReader (jsdom-safe). */
function readFileBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      const mimeMatch = /^data:([^;]+);base64/.exec(result);
      if (comma < 0 || !mimeMatch) {
        reject(new Error('unexpected data-url'));
        return;
      }
      resolve({ base64: result.slice(comma + 1), mimeType: mimeMatch[1] ?? file.type });
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// 图纸 (floorplan)
// ---------------------------------------------------------------------------

export function FloorplanImportPane({
  visibility,
  membersPlan,
  onClose,
  onSwitchMode,
}: ImportWizardPaneProps) {
  const { t } = useTranslation('environments');
  const { createFromDraft, createBusy, createError } = useCreateFromDraft(onClose);

  const [image, setImage] = useState<{ base64: string; mimeType: string; name: string } | null>(null);
  const [buildingId, setBuildingId] = useState('');
  const [floor, setFloor] = useState('0');
  const [pixelsPerMeter, setPixelsPerMeter] = useState('');
  const [calibPixels, setCalibPixels] = useState('');
  const [calibMeters, setCalibMeters] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visionUnavailable, setVisionUnavailable] = useState<string | null>(null);
  const [scaleSuggestion, setScaleSuggestion] = useState<number | null>(null);
  const [result, setResult] = useState<ScenarioImportDraft | null>(null);

  const pickImage = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    readFileBase64(file).then(
      ({ base64, mimeType }) => setImage({ base64, mimeType, name: file.name }),
      () => setError(t('create.importFileFailed')),
    );
  };

  const submit = async (ppmOverride?: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setVisionUnavailable(null);
    if (ppmOverride === undefined) setScaleSuggestion(null);
    try {
      if (!image) {
        setError(t('create.floorplan.imageRequired'));
        return;
      }
      if (buildingId.trim() === '') {
        setError(t('create.floorplan.buildingIdRequired'));
        return;
      }
      const floorNum = Number(floor);
      if (!Number.isInteger(floorNum)) {
        setError(t('create.floorplan.floorInvalid'));
        return;
      }
      const body: api.FloorplanImportInput = {
        image: { base64: image.base64, mimeType: image.mimeType },
        buildingId: buildingId.trim(),
        floor: floorNum,
      };
      const ppm = ppmOverride ?? (pixelsPerMeter.trim() === '' ? NaN : Number(pixelsPerMeter));
      const calibPx = calibPixels.trim() === '' ? NaN : Number(calibPixels);
      const calibM = calibMeters.trim() === '' ? NaN : Number(calibMeters);
      if (Number.isFinite(ppm) && ppm > 0) {
        body.pixelsPerMeter = ppm;
      } else if (Number.isFinite(calibPx) && calibPx > 0 && Number.isFinite(calibM) && calibM > 0) {
        body.calibration = { x1: 0, y1: 0, x2: calibPx, y2: 0, meters: calibM };
      }
      setResult(await api.importFloorplan(body));
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 503 && err.code === 'FLOORPLAN_VISION_UNAVAILABLE') {
          setVisionUnavailable(err.message);
          return;
        }
        // 502 (LLM configured but the endpoint is down / the model is not
        // vision-capable) is the COMMON shape on deployments with a primary
        // LLM configured — it deserves the same switch-lane teaching as 503
        // (ux-w3 probe P3), with the server's own detail preserved.
        if (err.status === 502 && err.code === 'FLOORPLAN_RECOGNITION_FAILED') {
          setVisionUnavailable(err.message);
          return;
        }
        if (err.status === 400) {
          const suggestion = parseScaleSuggestionFromMessage(err.message);
          if (suggestion !== null) setScaleSuggestion(suggestion);
        }
        setError(t('create.failed', { error: `${err.code}: ${err.message}` }));
      } else {
        setError(t('create.failed', { error: String(err) }));
      }
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <ImportDraftReview
        draft={result.draft}
        warnings={result.warnings}
        busy={createBusy}
        error={createError}
        onBack={() => setResult(null)}
        onConfirm={edited => void createFromDraft(edited, { visibility, membersPlan })}
      />
    );
  }

  if (visionUnavailable !== null) {
    return (
      <div className="import-teaching">
        <p className="import-teaching__title">{t('create.floorplan.visionTitle')}</p>
        <p className="page-note">{t('create.floorplan.visionBody')}</p>
        <p className="import-teaching__server">{visionUnavailable}</p>
        <div className="dialog__actions">
          <button onClick={() => onSwitchMode('ifc')}>{t('create.floorplan.gotoIfc')}</button>
          <button onClick={() => onSwitchMode('osm')}>{t('create.floorplan.gotoOsm')}</button>
          <button className="link-button" onClick={() => setVisionUnavailable(null)}>
            {t('create.review.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="dialog-field">
        {t('create.floorplan.imageLabel')}
        {/* R2-UX-22a: localized trigger instead of the browser-locale
            native file button; the picked name rides the button row. */}
        <FilePickButton
          label={t('create.filePickButton')}
          emptyLabel={t('create.filePickEmpty')}
          inputAriaLabel={t('create.floorplan.imageLabel')}
          accept="image/png,image/jpeg,image/webp"
          pickedName={image ? t('create.floorplan.imagePicked', { name: image.name }) : null}
          onPick={pickImage}
        />
      </div>
      <div className="geo-center-row">
        <label className="dialog-field">
          {t('create.floorplan.buildingIdLabel')}
          <input
            value={buildingId}
            onChange={event => setBuildingId(event.target.value)}
            placeholder={t('create.floorplan.buildingIdPlaceholder')}
          />
        </label>
        <label className="dialog-field">
          {t('create.floorplan.floorLabel')}
          <input
            type="number"
            step={1}
            value={floor}
            onChange={event => setFloor(event.target.value)}
          />
        </label>
      </div>
      <label className="dialog-field">
        {t('create.floorplan.ppmLabel')}
        <input
          type="number"
          step="any"
          min={0}
          value={pixelsPerMeter}
          onChange={event => setPixelsPerMeter(event.target.value)}
          placeholder={t('create.floorplan.ppmPlaceholder')}
        />
      </label>
      <p className="object-list__meta">{t('create.floorplan.calibHint')}</p>
      <div className="geo-center-row">
        <label className="dialog-field">
          {t('create.floorplan.calibPixelsLabel')}
          <input
            type="number"
            step="any"
            min={0}
            value={calibPixels}
            onChange={event => setCalibPixels(event.target.value)}
          />
        </label>
        <label className="dialog-field">
          {t('create.floorplan.calibMetersLabel')}
          <input
            type="number"
            step="any"
            min={0}
            value={calibMeters}
            onChange={event => setCalibMeters(event.target.value)}
          />
        </label>
      </div>
      {scaleSuggestion !== null && (
        <p className="import-scale-suggestion">
          {t('create.floorplan.scaleSuggestion', { value: scaleSuggestion })}{' '}
          <button
            className="chip chip--button"
            disabled={busy}
            onClick={() => {
              setPixelsPerMeter(String(scaleSuggestion));
              void submit(scaleSuggestion);
            }}
          >
            {t('create.floorplan.adoptScaleRetry')}
          </button>
        </p>
      )}
      {error && <p className="env-card__error">{error}</p>}
      <div className="dialog__actions">
        <button onClick={onClose} disabled={busy}>
          {t('create.cancel')}
        </button>
        <button className="primary-button" disabled={busy} onClick={() => void submit()}>
          {busy ? t('create.importing') : t('create.floorplan.submit')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// IFC
// ---------------------------------------------------------------------------

export function IfcImportPane({ visibility, membersPlan, onClose }: ImportWizardPaneProps) {
  const { t } = useTranslation('environments');
  const { createFromDraft, createBusy, createError } = useCreateFromDraft(onClose);

  const [file, setFile] = useState<{ base64: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioImportDraft | null>(null);

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    setError(null);
    readFileBase64(picked).then(
      ({ base64 }) => setFile({ base64, name: picked.name }),
      () => setError(t('create.importFileFailed')),
    );
  };

  const submit = async () => {
    if (busy) return;
    if (!file) {
      setError(t('create.ifc.fileRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importIfc({ ifc: file.base64 }));
    } catch (err) {
      setError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <ImportDraftReview
        draft={result.draft}
        warnings={result.warnings}
        busy={createBusy}
        error={createError}
        onBack={() => setResult(null)}
        onConfirm={edited => void createFromDraft(edited, { visibility, membersPlan })}
      />
    );
  }

  return (
    <>
      <div className="dialog-field">
        {t('create.ifc.fileLabel')}
        <FilePickButton
          label={t('create.filePickButton')}
          emptyLabel={t('create.filePickEmpty')}
          inputAriaLabel={t('create.ifc.fileLabel')}
          accept=".ifc"
          pickedName={file ? t('create.floorplan.imagePicked', { name: file.name }) : null}
          onPick={pickFile}
        />
      </div>
      {error && <p className="env-card__error">{error}</p>}
      <div className="dialog__actions">
        <button onClick={onClose} disabled={busy}>
          {t('create.cancel')}
        </button>
        <button className="primary-button" disabled={busy || !file} onClick={() => void submit()}>
          {busy ? t('create.importing') : t('create.ifc.submit')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// OSM
// ---------------------------------------------------------------------------

export function OsmImportPane({ visibility, membersPlan, onClose }: ImportWizardPaneProps) {
  const { t } = useTranslation('environments');
  const { createFromDraft, createBusy, createError } = useCreateFromDraft(onClose);

  const [source, setSource] = useState<'query' | 'bbox'>('query');
  const [query, setQuery] = useState('');
  const [south, setSouth] = useState('');
  const [west, setWest] = useState('');
  const [north, setNorth] = useState('');
  const [east, setEast] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioImportDraft | null>(null);

  const submit = async () => {
    if (busy) return;
    setError(null);
    let body: { bbox: [number, number, number, number] } | { query: string };
    if (source === 'query') {
      if (query.trim() === '') {
        setError(t('create.osm.queryRequired'));
        return;
      }
      body = { query: query.trim() };
    } else {
      const values = [south, west, north, east].map(v => Number(v));
      if (values.some(v => !Number.isFinite(v))) {
        setError(t('create.osm.bboxInvalid'));
        return;
      }
      body = { bbox: values as [number, number, number, number] };
    }
    setBusy(true);
    try {
      setResult(await api.importOsm(body));
    } catch (err) {
      setError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <ImportDraftReview
        draft={result.draft}
        warnings={result.warnings}
        busy={createBusy}
        error={createError}
        onBack={() => setResult(null)}
        onConfirm={edited => void createFromDraft(edited, { visibility, membersPlan })}
      />
    );
  }

  return (
    <>
      <div className="home-tabs">
        <button
          className={source === 'query' ? 'home-tab home-tab--active' : 'home-tab'}
          onClick={() => setSource('query')}
        >
          {t('create.osm.sourceQuery')}
        </button>
        <button
          className={source === 'bbox' ? 'home-tab home-tab--active' : 'home-tab'}
          onClick={() => setSource('bbox')}
        >
          {t('create.osm.sourceBbox')}
        </button>
      </div>
      {source === 'query' ? (
        <label className="dialog-field">
          {t('create.osm.queryLabel')}
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('create.osm.queryPlaceholder')}
          />
        </label>
      ) : (
        <div className="geo-center-row">
          <label className="dialog-field">
            {t('create.osm.south')}
            <input type="number" step="any" value={south} onChange={e => setSouth(e.target.value)} />
          </label>
          <label className="dialog-field">
            {t('create.osm.west')}
            <input type="number" step="any" value={west} onChange={e => setWest(e.target.value)} />
          </label>
          <label className="dialog-field">
            {t('create.osm.north')}
            <input type="number" step="any" value={north} onChange={e => setNorth(e.target.value)} />
          </label>
          <label className="dialog-field">
            {t('create.osm.east')}
            <input type="number" step="any" value={east} onChange={e => setEast(e.target.value)} />
          </label>
        </div>
      )}
      {error && <p className="env-card__error">{error}</p>}
      <div className="dialog__actions">
        <button onClick={onClose} disabled={busy}>
          {t('create.cancel')}
        </button>
        <button className="primary-button" disabled={busy} onClick={() => void submit()}>
          {busy ? t('create.importing') : t('create.osm.submit')}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 一句话 (NL, UX-W5)
// ---------------------------------------------------------------------------

/** Example chips — same phrasing family the 422 teaching message quotes. */
const NL_EXAMPLES = [
  'create.nl.exampleHospital',
  'create.nl.exampleMall',
  'create.nl.exampleOffice',
] as const;

export function NlImportPane({ visibility, membersPlan, onClose, onSwitchMode }: ImportWizardPaneProps) {
  const { t } = useTranslation('environments');
  const { createFromDraft, createBusy, createError } = useCreateFromDraft(onClose);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmUnavailable, setLlmUnavailable] = useState<string | null>(null);
  const [result, setResult] = useState<ScenarioImportDraft | null>(null);

  const submit = async () => {
    if (busy) return;
    if (text.trim() === '') {
      setError(t('create.nl.textRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    setLlmUnavailable(null);
    try {
      setResult(await api.importNl({ text: text.trim() }));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 503 && err.code === 'NL_IMPORT_UNAVAILABLE') {
        setLlmUnavailable(err.message);
        return;
      }
      // 422 NL_IMPORT_NO_BUILDING keeps the server's example phrasings
      // inline — they ARE the teaching (same discipline as IFC 422).
      setError(
        t('create.failed', {
          error:
            err instanceof ApiClientError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <ImportDraftReview
        draft={result.draft}
        warnings={result.warnings}
        busy={createBusy}
        error={createError}
        onBack={() => setResult(null)}
        onConfirm={edited => void createFromDraft(edited, { visibility, membersPlan })}
      />
    );
  }

  if (llmUnavailable !== null) {
    return (
      <div className="import-teaching">
        <p className="import-teaching__title">{t('create.nl.unavailableTitle')}</p>
        <p className="page-note">{t('create.nl.unavailableBody')}</p>
        <p className="import-teaching__server">{llmUnavailable}</p>
        <div className="dialog__actions">
          <button onClick={() => onSwitchMode('ifc')}>{t('create.floorplan.gotoIfc')}</button>
          <button onClick={() => onSwitchMode('osm')}>{t('create.floorplan.gotoOsm')}</button>
          <button className="link-button" onClick={() => setLlmUnavailable(null)}>
            {t('create.review.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <label className="dialog-field">
        {t('create.nl.textLabel')}
        <textarea
          className="dialog__textarea"
          rows={4}
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder={t('create.nl.textPlaceholder')}
        />
      </label>
      <div className="import-nl__examples">
        <span className="object-list__meta">{t('create.nl.examplesTitle')}</span>
        {NL_EXAMPLES.map(key => (
          <button key={key} className="chip chip--button" disabled={busy} onClick={() => setText(t(key))}>
            {t(key)}
          </button>
        ))}
      </div>
      {error && <p className="env-card__error">{error}</p>}
      <div className="dialog__actions">
        <button onClick={onClose} disabled={busy}>
          {t('create.cancel')}
        </button>
        <button className="primary-button" disabled={busy || text.trim() === ''} onClick={() => void submit()}>
          {busy ? t('create.importing') : t('create.nl.submit')}
        </button>
      </div>
    </>
  );
}
