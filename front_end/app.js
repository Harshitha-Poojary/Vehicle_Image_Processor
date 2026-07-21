const API_BASE = '';
const POLL_INTERVAL_MS = 1500;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const dzIdle     = document.getElementById('dzIdle');
const dzPreview  = document.getElementById('dzPreview');
const previewImg = document.getElementById('previewImg');
const previewName= document.getElementById('previewName');
const previewSize= document.getElementById('previewSize');
const clearBtn   = document.getElementById('clearBtn');
const submitBtn  = document.getElementById('submitBtn');
const uploadHint = document.getElementById('uploadHint');

const bayTicket  = document.getElementById('bay-ticket');
const ticketId   = document.getElementById('ticketId');
const statusBadge= document.getElementById('statusBadge');
const statusText = statusBadge.querySelector('.status-text');
const stepsEls   = document.getElementById('steps');
const ticketNote = document.getElementById('ticketNote');

const bayResults = document.getElementById('bay-results');
const docketId   = document.getElementById('docketId');
const stamp      = document.getElementById('stamp');
const issuesList = document.getElementById('issuesList');
const noIssues   = document.getElementById('noIssues');
const metaGrid   = document.getElementById('metaGrid');
const toggleRaw  = document.getElementById('toggleRaw');
const rawJson    = document.getElementById('rawJson');

const recentBody = document.getElementById('recentBody');

let selectedFile = null;
let pollTimer = null;
let recent = [];

function fmtBytes(bytes){
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/(1024*1024)).toFixed(2)} MB`;
}

function showError(container, message){
  const existing = container.querySelector('.error-banner');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'error-banner';
  div.textContent = message;
  container.appendChild(div);
}

function clearError(container){
  const existing = container.querySelector('.error-banner');
  if (existing) existing.remove();
}

async function apiFetch(path, options){
  const res = await fetch(`${API_BASE}${path}`, options);
  let body = null;
  try { body = await res.json(); } catch (_) { }
  if (!res.ok){
    const msg = (body && (body.error || body.message)) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function openPicker(){ fileInput.click(); }

dropzone.addEventListener('click', openPicker);
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openPicker(); }
});

['dragenter','dragover'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  })
);
['dragleave','drop'].forEach(evt =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFileSelected(file);
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) handleFileSelected(file);
});
clearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  resetUpload();
});

function handleFileSelected(file){
  clearError(document.getElementById('bay-upload'));

  const allowed = ['image/jpeg','image/png','image/webp'];
  if (!allowed.includes(file.type)){
    showError(document.getElementById('bay-upload'), 'Unsupported file type. Please choose a JPEG, PNG, or WEBP image.');
    return;
  }
  if (file.size > MAX_FILE_BYTES){
    showError(document.getElementById('bay-upload'), `That file is ${fmtBytes(file.size)} — the limit is 15MB.`);
    return;
  }

  selectedFile = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewName.textContent = file.name;
  previewSize.textContent = fmtBytes(file.size);

  dzIdle.hidden = true;
  dzPreview.hidden = false;
  submitBtn.disabled = false;
  uploadHint.textContent = 'Ready to send.';
}

function resetUpload(){
  selectedFile = null;
  fileInput.value = '';
  dzIdle.hidden = false;
  dzPreview.hidden = true;
  submitBtn.disabled = true;
  uploadHint.textContent = 'Select a photo to begin.';
}

submitBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  clearError(document.getElementById('bay-upload'));
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';

  try {
    const formData = new FormData();
    formData.append('image', selectedFile);
    const created = await apiFetch('/api/images', { method: 'POST', body: formData });

    addRecent({
      id: created.id,
      filename: selectedFile.name,
      status: created.status || 'pending',
      verdict: null,
      uploadedAt: created.uploaded_at
    });

    openTicket(created);
    resetUpload();
  } catch (err) {
    showError(document.getElementById('bay-upload'), err.message || 'Upload failed. Please try again.');
  } finally {
    submitBtn.textContent = 'Send to inspection';
    submitBtn.disabled = !selectedFile;
  }
});

function openTicket(created){
  bayResults.hidden = true;
  bayTicket.hidden = false;
  ticketId.textContent = created.id;
  setStatus('pending');
  ticketNote.textContent = 'Waiting for a worker to pick this up…';
  bayTicket.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollStatus(created.id), POLL_INTERVAL_MS);
  pollStatus(created.id);
}

function setStatus(state){
  statusBadge.dataset.state = state;
  statusText.textContent = state;
  const order = ['uploaded','pending','processing','completed'];
  const activeIndex = state === 'failed' ? order.length : order.indexOf(state === 'completed' ? 'completed' : state);
  [...stepsEls.children].forEach((li) => {
    const idx = order.indexOf(li.dataset.step);
    li.classList.remove('done','active');
    if (state === 'failed'){
      if (li.dataset.step === 'uploaded' || li.dataset.step === 'pending') li.classList.add('done');
      return;
    }
    if (idx < activeIndex) li.classList.add('done');
    else if (idx === activeIndex) li.classList.add('active','done');
  });
}

async function pollStatus(id){
  try {
    const data = await apiFetch(`/api/images/${id}/status`);
    setStatus(data.status);
    updateRecent(id, { status: data.status });

    if (data.status === 'completed'){
      clearInterval(pollTimer);
      ticketNote.textContent = 'Processing complete — building the docket…';
      const result = await apiFetch(`/api/images/${id}/result`);
      renderResult(result);
      updateRecent(id, { status: 'completed', verdict: result.overall_verdict });
    } else if (data.status === 'failed'){
      clearInterval(pollTimer);
      ticketNote.textContent = data.failure_reason
        ? `Processing failed: ${data.failure_reason}`
        : 'Processing failed for this image.';
      updateRecent(id, { status: 'failed' });
    } else if (data.status === 'processing'){
      ticketNote.textContent = 'Running checks: blur, brightness, duplicate, screenshot, tamper, plate format…';
    } else {
      ticketNote.textContent = 'Waiting for a worker to pick this up…';
    }
  } catch (err) {
    clearInterval(pollTimer);
    showError(bayTicket, err.message || 'Lost contact with the server while checking status.');
  }
}

const VERDICT_LABEL = { clean: 'CLEAN', needs_review: 'REVIEW', rejected: 'REJECTED' };

function renderResult(result){
  bayResults.hidden = false;
  docketId.textContent = result.id;

  const verdict = result.overall_verdict || 'clean';
  stamp.dataset.verdict = verdict;
  stamp.textContent = VERDICT_LABEL[verdict] || verdict.toUpperCase();

  issuesList.innerHTML = '';
  noIssues.hidden = true;
  metaGrid.innerHTML = '';
  rawJson.hidden = true;
  toggleRaw.textContent = 'Show raw check data ▾';

  const issues = Array.isArray(result.issues) ? result.issues : [];
  if (issues.length === 0) {
    noIssues.hidden = false;
  } else {
    issues.forEach((issue) => {
      const li = document.createElement('li');
      li.className = 'issue-item';
      li.dataset.severity = issue.severity || 'low';
      li.innerHTML = `<div class="issue-top"><span class="issue-type">${issue.type || 'issue'}</span><span class="issue-confidence">${Math.round((issue.confidence || 0) * 100)}%</span></div><p class="issue-detail">${issue.detail || ''}</p>`;
      issuesList.appendChild(li);
    });
  }

  const metadata = result.metadata || {};
  Object.entries(metadata).forEach(([key, value]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = key;
    dd.textContent = value;
    metaGrid.appendChild(dt);
    metaGrid.appendChild(dd);
  });

  toggleRaw.onclick = () => {
    const showing = !rawJson.hidden;
    rawJson.hidden = showing;
    toggleRaw.textContent = showing ? 'Show raw check data ▾' : 'Hide raw check data ▴';
    if (!showing) {
      rawJson.textContent = JSON.stringify(result.checks || {}, null, 2);
    }
  };
}

function addRecent(item){
  recent = [{ ...item }, ...recent.filter((x) => x.id !== item.id)].slice(0, 8);
  renderRecent();
}

function updateRecent(id, patch){
  recent = recent.map((item) => item.id === id ? { ...item, ...patch } : item);
  renderRecent();
}

function renderRecent(){
  recentBody.innerHTML = '';
  if (!recent.length) {
    recentBody.innerHTML = '<tr class="recent-empty"><td colspan="5">Nothing processed yet this session.</td></tr>';
    return;
  }

  recent.forEach((item) => {
    const tr = document.createElement('tr');
    const verdict = item.verdict ? `<span class="verdict-pill ${item.verdict}">${item.verdict}</span>` : '<span class="verdict-pill pending">pending</span>';
    tr.innerHTML = `<td>${item.filename || item.id}</td><td>${item.status || 'pending'}</td><td>${verdict}</td><td>${item.uploadedAt ? new Date(item.uploadedAt).toLocaleString() : '—'}</td><td><button class="row-link" type="button">view</button></td>`;
    recentBody.appendChild(tr);
  });
}

renderRecent();
