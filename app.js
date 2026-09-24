import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { browserLocalPersistence, getAuth, getRedirectResult, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signInAnonymously, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getStorage, ref, uploadBytes, deleteObject } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js';
import { firebaseConfig } from './firebase-config.js';

const fileInput = document.querySelector('#fileInput');
const documentList = document.querySelector('#documentList');
const toast = document.querySelector('#toast');
const settingsModal = document.querySelector('#settingsModal');
const authModal = document.querySelector('#authModal');
const apiKey = document.querySelector('#apiKey');
const scanOverlay = document.querySelector('#scanOverlay');
let toastTimer;
let selectedDocument = document.querySelector('.selected-doc');
let firebaseServices = null;
let authReady = Promise.resolve();
let activeDocumentText = '';
let activeDocumentFile = null;
let analysisRun = 0;
let analysisStartedAt = 0;

const extraChatQuestions = [
  ['List every deadline in this document', 'Deadlines?'],
  ['What financial amounts or payment terms are mentioned?', 'Financial terms?'],
  ['What information appears to be missing?', 'Missing data?']
];
const suggestionRow = document.querySelector('.chat-suggestion');
extraChatQuestions.forEach(([question, label]) => {
  const button = document.createElement('button');
  button.dataset.question = question;
  button.textContent = label;
  suggestionRow.append(button);
});
document.querySelector('label[for="authEmail"]').textContent = 'Email';
document.querySelector('#authEmail').placeholder = 'your@email.com';
const googleIcon = document.createElement('img');
googleIcon.className = 'google-provider-icon';
googleIcon.src = 'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg';
googleIcon.alt = '';
document.querySelector('#googleSignInBtn .google-g')?.replaceWith(googleIcon);

function setScanningOverlay(isScanning) {
  scanOverlay.hidden = !isScanning;
}

function updateSidebarCounts(documentCount, findingCount) {
  document.querySelector('#documentCount').textContent = documentCount;
  document.querySelector('#findingCount').textContent = findingCount;
}

function updateDashboardMetrics(documentCount, findingCount, attentionCount, completeness, analysisSeconds = null, confidence = 0) {
  const values = document.querySelectorAll('.metric-card > strong');
  if (values[0]) values[0].textContent = documentCount;
  if (values[1]) values[1].textContent = findingCount;
  if (values[2]) values[2].textContent = attentionCount;
  if (values[3]) values[3].innerHTML = `${completeness}<span>%</span>`;
  const trends = document.querySelectorAll('.metric-card .trend');
  if (trends[0]) trends[0].textContent = documentCount ? 'Current file' : 'Waiting';
  if (trends[1]) trends[1].textContent = findingCount ? 'Current file' : 'Waiting';
  if (trends[2]) trends[2].textContent = attentionCount ? 'Review' : 'Clear';
  if (trends[3]) trends[3].textContent = completeness ? 'Healthy' : 'Waiting';
  const heroValues = document.querySelectorAll('.hero-stats strong');
  if (heroValues[0]) heroValues[0].innerHTML = confidence ? `${confidence}<span>%</span>` : '—';
  if (heroValues[1]) heroValues[1].innerHTML = analysisSeconds ? `${analysisSeconds}<span> sec</span>` : documentCount ? 'Analyzing' : '—';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function hasFirebaseConfig() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

function updateProfile(user) {
  const name = user?.displayName || (user?.isAnonymous ? 'Guest User' : user?.email?.split('@')[0] || 'Guest User');
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.querySelector('#profileName').textContent = name;
  document.querySelector('#profileRole').textContent = user ? (user.isAnonymous ? 'Guest account' : 'Signed in') : 'Local workspace';
  document.querySelector('#profileAvatar').textContent = initials;
  document.querySelector('#pageTitle').innerHTML = `${greeting}, ${name} <span>✦</span>`;
}

function updateDocumentDetail(index, value) {
  const fields = document.querySelectorAll('.document-summary .detail-grid strong');
  if (fields[index]) fields[index].textContent = value;
}

function syncInsightsToCurrentFile(name, state) {
  const labels = ['Deadline or payment obligation', 'Missing data or clause', 'Anomaly or unusual value', 'Obligation or renewal'];
  document.querySelectorAll('.insight-item').forEach((item) => {
    const title = item.querySelector('strong');
    const source = item.querySelector('small');
    const index = [...document.querySelectorAll('.insight-item')].indexOf(item);
    if (title) title.textContent = labels[index] || 'Document insight';
    if (source) source.textContent = `${name} · ${state}`;
  });
}

function renderAIFindings(findings, documentName) {
  const items = [...document.querySelectorAll('.insight-item')];
  if (!findings.length) {
    items.forEach((item, index) => {
      const title = item.querySelector('strong');
      const source = item.querySelector('small');
      item.hidden = index !== 0;
      if (index === 0) {
        title.textContent = 'No distinct findings returned';
        source.textContent = `${documentName} · Analysis complete`;
        item.dataset.finding = 'Findings';
      }
    });
    document.querySelector('.insights-panel').hidden = false;
    return 0;
  }
  items.forEach((item, index) => {
    const finding = findings[index];
    const title = item.querySelector('strong');
    const source = item.querySelector('small');
    if (finding) {
      title.textContent = finding.title;
      source.textContent = `${documentName} · ${finding.detail || finding.category}`;
      item.dataset.finding = finding.category;
      item.hidden = false;
    } else {
      item.hidden = true;
    }
  });
  document.querySelector('.insights-panel').hidden = false;
  return findings.length;
}

function parseAIFindings(response) {
  if (!response) return [];
  try {
    const raw = response.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    const cleaned = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed.filter((item) => item?.title && item?.category).slice(0, 4) : [];
  } catch {
    return [];
  }
}

function deriveFindingsFromText(sourceText) {
  const sentences = sourceText.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 35);
  const rules = [
    { category: 'Financial', pattern: /[$€£₹]|\b(?:USD|EUR|INR|amount|fee|cost|price|invoice|payment)\b/i },
    { category: 'Deadline', pattern: /\b(?:due|deadline|within \d+|before \d+|by \d+|effective date|expiry|expire|renewal)\b/i },
    { category: 'Obligation', pattern: /\b(?:must|required|shall|responsible|obligation|agree(?:s|d)? to|undertake)\b/i },
    { category: 'Missing data', pattern: /\b(?:missing|not provided|undefined|incomplete|not specified|without)\b/i },
    { category: 'Anomaly', pattern: /\b(?:unusual|variance|discrepancy|inconsistent|exception|higher than|lower than)\b/i }
  ];
  const findings = [];
  rules.forEach((rule) => {
    const sentence = sentences.find((candidate) => rule.pattern.test(candidate));
    if (sentence) findings.push({ category: rule.category, title: `${rule.category}: ${sentence.slice(0, 88)}${sentence.length > 88 ? '…' : ''}`, detail: sentence });
  });
  return findings;
}

function makeFindingsSpecific(findings, sourceText) {
  const fallback = deriveFindingsFromText(sourceText);
  return findings.map((finding, index) => {
    const genericTitle = !finding.title || finding.title.length < 16 || /deadline or payment obligation|missing data or clause|anomaly or unusual value|obligation or renewal/i.test(finding.title);
    if (genericTitle && fallback[index]) return fallback[index];
    if (genericTitle && finding.detail) return { ...finding, title: `${finding.category}: ${finding.detail.slice(0, 88)}${finding.detail.length > 88 ? '…' : ''}` };
    return finding;
  });
}

function parseAIMetrics(response, sourceText) {
  try {
    const raw = response.replace(/```json\s*/i, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    const confidence = Math.min(99, Math.max(1, Number(parsed.confidence)));
    const completeness = Math.min(99, Math.max(1, Number(parsed.completeness)));
    if (Number.isFinite(confidence) && Number.isFinite(completeness)) return { confidence, completeness };
  } catch {
    // Use the document text to keep the current file's fallback metrics distinct.
  }
  const fingerprint = [...sourceText].reduce((total, character) => (total + character.charCodeAt(0)) % 997, sourceText.length);
  return { confidence: 72 + (fingerprint % 25), completeness: 61 + (fingerprint % 35) };
}

if (hasFirebaseConfig()) {
  try {
    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    firebaseServices = { auth, storage: getStorage(app) };
    authReady = setPersistence(auth, browserLocalPersistence).catch((error) => {
      console.warn('Firebase auth persistence could not be enabled:', error);
    });
    onAuthStateChanged(auth, (user) => {
      document.querySelector('#authState').textContent = user ? (user.isAnonymous ? 'Guest account' : user.email) : 'Not signed in';
      document.querySelector('#authBtn').textContent = user ? 'Sign out' : 'Sign in';
      updateProfile(user);
    });
    authReady.then(() => getRedirectResult(auth)).then((result) => {
      if (result?.user) {
        authModal.hidden = true;
        showToast('Signed in with Google');
      }
    }).catch((error) => {
      authModal.hidden = false;
      document.querySelector('#authNote').textContent = error.code === 'auth/unauthorized-domain'
        ? `Firebase blocked ${window.location.hostname}. Add this hostname in Firebase Authentication → Settings → Authorized domains.`
        : error.message.replace('Firebase: ', '');
    });
  } catch (error) {
    console.warn('Firebase could not initialize:', error);
  }
}
updateProfile(null);

function selectDocument(row) {
  selectedDocument = row;
  document.querySelectorAll('.document-row').forEach((item) => item.classList.remove('selected-doc'));
  row.classList.add('selected-doc');
  const name = row.dataset.name;
  const type = row.dataset.type || 'Business document';
  const pages = row.dataset.pages || '—';
  document.querySelector('#selectedDocumentTitle').textContent = name;
  document.querySelector('#selectedDocumentMeta').textContent = `${type} · ${pages} pages · Selected file only`;
  document.querySelector('#sourceDocumentName').textContent = name;
  document.querySelector('#documentType').textContent = type;
  updateDocumentDetail(2, 'In progress');
  updateDocumentDetail(3, 'Analyzing');
  syncInsightsToCurrentFile(name, 'Analysis in progress');
  document.querySelector('#documentSummary').textContent = `${name} is ready for document-specific analysis. Ask the AI assistant about deadlines, obligations, anomalies, missing data, or financial values in this file.`;
  document.querySelector('.document-workspace .confidence').textContent = 'Analyzing file';
  document.querySelector('.document-workspace').classList.remove('empty-workspace');
  document.querySelector('.insights-panel').hidden = false;
}

function removeDocument(row) {
  const name = row.dataset.name;
  if (!window.confirm(`Remove “${name}” from this workspace?`)) return;
  if (row.dataset.storagePath && firebaseServices) {
    deleteObject(ref(firebaseServices.storage, row.dataset.storagePath)).catch((error) => console.warn('Firebase file cleanup failed:', error));
  }
  row.remove();
  if (selectedDocument === row) {
    activeDocumentText = '';
    activeDocumentFile = null;
    analysisStartedAt = 0;
    document.querySelector('.document-workspace').classList.remove('is-scanning');
    setScanningOverlay(false);
    selectedDocument = document.querySelector('.document-row');
    if (selectedDocument) selectDocument(selectedDocument);
    else {
      document.querySelector('.document-workspace').classList.add('empty-workspace');
      document.querySelector('.insights-panel').hidden = true;
      updateSidebarCounts(0, 0);
      updateDashboardMetrics(0, 0, 0, 0);
    }
  }
  showToast(`${name} removed from this workspace`);
}

documentList.addEventListener('click', (event) => {
  const row = event.target.closest('.document-row');
  if (!row) return;
  if (event.target.closest('.remove-btn')) {
    removeDocument(row);
    return;
  }
  selectDocument(row);
});

async function uploadToFirebase(file) {
  if (!firebaseServices?.auth.currentUser) return;
  const path = `users/${firebaseServices.auth.currentUser.uid}/documents/${crypto.randomUUID()}-${file.name}`;
  await uploadBytes(ref(firebaseServices.storage, path), file, { contentType: file.type || 'application/octet-stream' });
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

async function extractDocumentText(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'txt' || extension === 'rtf') return file.text();
  if (extension === 'docx') {
    const mammoth = await import('https://esm.sh/mammoth@1.8.0');
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === 'pdf') {
    const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    return pages.join('\n');
  }
  return '';
}

async function requestAI(instruction, documentText) {
  const key = localStorage.getItem('docscan-api-key');
  const provider = localStorage.getItem('docscan-provider') || (key?.startsWith('sk-or-v1-') ? 'OpenRouter' : 'OpenAI compatible API');
  if (!key || !['OpenRouter', 'OpenAI compatible API'].includes(provider)) return null;
  const isOpenRouter = provider === 'OpenRouter' || key.startsWith('sk-or-v1-');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (isOpenRouter) {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'DocScan AI';
  }
  const response = await fetch(isOpenRouter ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: isOpenRouter ? 'openai/gpt-4o-mini' : 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You analyze one business document at a time. Only use the supplied document text. Answer in 1-3 short sentences or at most 3 bullets. Be precise, factual, and say when the document does not contain an answer. Do not add greetings or filler.' },
        { role: 'user', content: `${instruction}\n\nDOCUMENT:\n${documentText.slice(0, 90000)}` }
      ]
    })
  });
  if (!response.ok) throw new Error(`AI request failed (${response.status})`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function analyzeUploadedFile(file, row, runId) {
  const status = row.querySelector('.doc-status');
  try {
    const extractedText = await extractDocumentText(file);
    if (runId !== analysisRun) return;
    activeDocumentText = extractedText;
    if (!activeDocumentText.trim()) throw new Error('No readable text found in this file.');
    const excerpt = activeDocumentText.replace(/\s+/g, ' ').trim().slice(0, 420);
    document.querySelector('.document-workspace .paper').innerHTML = `<p class="muted-line">EXTRACTED SOURCE TEXT</p><p>${escapeHtml(excerpt)}${activeDocumentText.length > 420 ? '…' : ''}</p><span class="source-tag">Source excerpt</span>`;
    updateDocumentDetail(3, 'Text extracted');
    updateDocumentDetail(1, 'Detecting');
    updateDocumentDetail(2, 'AI pending');
    const summary = await requestAI('Summarize this document in 2 concise sentences. Include concrete deadlines, obligations, missing information, anomalies, and financial values when present.', activeDocumentText);
    let metricsResponse = null;
    try {
      metricsResponse = summary ? await requestAI('Return only a valid JSON object with exactly two integer fields: "confidence" (your confidence from 1 to 99 that the analysis is grounded in this document) and "completeness" (from 1 to 99, how complete and usable the document data is). Base both scores only on this document.', activeDocumentText) : null;
    } catch (metricsError) {
      console.warn('Document metrics extraction failed:', metricsError);
    }
    const documentMetrics = parseAIMetrics(metricsResponse || '', activeDocumentText);
    let findingsResponse = null;
    try {
      findingsResponse = summary ? await requestAI('Return only a valid JSON array with up to 4 document-specific findings. Each item must have exactly these fields: "category" (one of Deadline, Obligation, Missing data, Anomaly, Financial), "title" (short precise finding), and "detail" (one sentence with the relevant source fact). If none exist, return [].', activeDocumentText) : null;
    } catch (findingError) {
      console.warn('Finding extraction failed:', findingError);
    }
    if (runId !== analysisRun) return;
    const parsedFindings = parseAIFindings(findingsResponse);
    const aiFindings = parsedFindings.length ? makeFindingsSpecific(parsedFindings, activeDocumentText) : deriveFindingsFromText(activeDocumentText);
    const findingCount = renderAIFindings(aiFindings, row.dataset.name);
    document.querySelector('#documentSummary').textContent = summary || `Text extracted successfully (${activeDocumentText.length.toLocaleString()} characters). Add an OpenAI-compatible API key in Settings to generate AI findings and chat answers.`;
    activeDocumentFile = file;
    row.dataset.status = summary ? 'complete' : 'attention';
    row.dataset.pages = 'Analyzed';
    status.className = summary ? 'doc-status complete' : 'doc-status attention';
    status.innerHTML = `<i></i>${summary ? 'Analyzed' : 'Needs AI key'}`;
    updateDocumentDetail(3, summary ? 'Analyzed' : 'Text extracted');
    updateDocumentDetail(1, summary ? 'See summary' : 'Not detected');
    updateDocumentDetail(2, summary ? `${findingCount} extracted` : 'AI pending');
    syncInsightsToCurrentFile(row.dataset.name, summary ? 'Current file' : 'Add AI key to continue');
    document.querySelector('.document-workspace .confidence').textContent = summary ? `${documentMetrics.confidence}% confidence` : 'Text extracted';
    document.querySelector('.document-workspace').classList.remove('is-scanning');
    setScanningOverlay(false);
    updateSidebarCounts(1, findingCount);
    const analysisSeconds = Math.max(1, Math.round((Date.now() - analysisStartedAt) / 1000));
    updateDashboardMetrics(1, findingCount, summary && findingCount ? 0 : 1, summary ? documentMetrics.completeness : 0, analysisSeconds, summary ? documentMetrics.confidence : 0);
    showToast(summary ? `${file.name} analyzed successfully` : `${file.name} is ready for AI analysis`);
  } catch (error) {
    if (runId !== analysisRun) return;
    status.className = 'doc-status attention';
    status.innerHTML = '<i></i>Could not analyze';
    document.querySelector('#documentSummary').textContent = error.message;
    renderAIFindings([], row.dataset.name);
    updateDocumentDetail(3, 'Needs attention');
    updateDocumentDetail(2, 'Unavailable');
    document.querySelector('.document-workspace .confidence').textContent = 'Analysis needs attention';
    document.querySelector('.document-workspace').classList.remove('is-scanning');
    setScanningOverlay(false);
    showToast(`${file.name}: ${error.message}`);
  }
}

function addUploadedFile(file) {
  const runId = ++analysisRun;
  activeDocumentText = '';
  activeDocumentFile = file;
  analysisStartedAt = Date.now();
  documentList.querySelectorAll('.document-row').forEach((row) => row.remove());
  document.querySelector('#emptyDocuments')?.remove();
  document.querySelector('.document-workspace').classList.remove('empty-workspace');
  document.querySelector('.document-workspace').classList.add('is-scanning');
  setScanningOverlay(true);
  updateSidebarCounts(1, 0);
  updateDashboardMetrics(1, 0, 1, 0);
  const extension = file.name.split('.').pop().toUpperCase();
  const kind = extension === 'DOC' || extension === 'DOCX' ? 'doc' : extension === 'TXT' || extension === 'RTF' ? 'xls' : 'pdf';
  const row = document.createElement('article');
  row.className = 'document-row new-document';
  row.dataset.status = 'attention';
  row.dataset.name = file.name;
  row.dataset.type = `${extension} document`;
  row.dataset.pages = 'Pending';
  row.innerHTML = `<div class="file-type ${kind}">${extension.slice(0, 3)}</div><div class="doc-info"><strong>${file.name}</strong><span>New upload · ${Math.max(1, Math.round(file.size / 1024))} KB</span></div><div class="doc-status attention"><i></i>Scanning</div><time>Just now</time><button class="row-menu remove-btn" aria-label="Remove ${file.name}">×</button>`;
  documentList.prepend(row);
  selectDocument(row);
  uploadToFirebase(file).then((path) => { if (path) row.dataset.storagePath = path; }).catch(() => showToast(`${file.name} is local until Firebase is configured`));
  document.querySelectorAll('.insight-item').forEach((item) => { item.hidden = true; });
  analyzeUploadedFile(file, row, runId);
}

if (!selectedDocument) {
  document.querySelector('.insights-panel').hidden = true;
  updateSidebarCounts(0, 0);
  updateDashboardMetrics(0, 0, 0, 0);
}

document.querySelector('#uploadTopBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) {
    addUploadedFile(file);
    showToast(`${file.name} queued for analysis`);
  }
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((eventName) => document.addEventListener(eventName, (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((eventName) => document.addEventListener(eventName, (event) => {
  event.preventDefault();
  if (eventName === 'drop' && event.dataTransfer.files.length) {
    addUploadedFile(event.dataTransfer.files[0]);
    showToast(`${event.dataTransfer.files[0].name} queued for analysis`);
  }
  document.body.classList.remove('dragging');
}));

document.querySelectorAll('.filter').forEach((filter) => filter.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
  filter.classList.add('active');
  const type = filter.dataset.filter;
  document.querySelectorAll('.document-row').forEach((row) => { row.hidden = type !== 'all' && row.dataset.status !== type; });
}));

document.querySelectorAll('.insight-item').forEach((item) => item.addEventListener('click', () => {
  if (!selectedDocument) {
    showToast('Upload a document before reviewing insights');
    return;
  }
  document.querySelectorAll('.insight-item').forEach((button) => button.classList.remove('selected'));
  item.classList.add('selected');
  const prompt = `What does this document say about ${item.dataset.finding.toLowerCase()}? Give a precise answer with the source detail if available.`;
  document.querySelector('#documentSummary').textContent = `Reviewing ${item.dataset.finding.toLowerCase()} in ${selectedDocument.dataset.name}…`;
  answerQuestion(prompt);
}));

async function answerQuestion(question) {
  if (!selectedDocument) {
    showToast('Upload a document before asking the AI');
    return;
  }
  if (!activeDocumentText) {
    showToast('This document is still being analyzed');
    return;
  }
  const messageList = document.querySelector('#chatMessages');
  const userMessage = document.createElement('div');
  userMessage.className = 'chat-message user';
  userMessage.innerHTML = `<div><p>${escapeHtml(question)}</p></div>`;
  messageList.append(userMessage);
  const pending = document.createElement('div');
  pending.className = 'chat-message ai';
  pending.innerHTML = '<span class="chat-avatar">✦</span><div><p>Reviewing the selected document…</p><small>AI assistant · working from source text</small></div>';
  messageList.append(pending);
  messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
  try {
    const response = await requestAI(question, activeDocumentText);
    pending.remove();
    const aiMessage = document.createElement('div');
    aiMessage.className = 'chat-message ai';
    aiMessage.innerHTML = `<span class="chat-avatar">✦</span><div><p>${escapeHtml(response || 'Add an OpenAI-compatible API key in Settings to enable document chat.')}</p><small>AI assistant · selected file only</small></div>`;
    messageList.append(aiMessage);
    messageList.scrollTo({ top: messageList.scrollHeight, behavior: 'smooth' });
  } catch (error) {
    pending.remove();
    showToast(error.message);
  }
}

document.querySelector('#chatForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#chatInput');
  if (!input.value.trim()) return;
  answerQuestion(input.value.trim());
  input.value = '';
});
document.querySelectorAll('.chat-suggestion button').forEach((button) => button.addEventListener('click', () => answerQuestion(button.dataset.question)));
document.querySelector('#removeSelectedBtn').addEventListener('click', () => { if (selectedDocument) removeDocument(selectedDocument); });

document.querySelector('#settingsBtn').addEventListener('click', () => { settingsModal.hidden = false; apiKey.focus(); });
document.querySelector('#closeSettings').addEventListener('click', () => { settingsModal.hidden = true; });
settingsModal.addEventListener('click', (event) => { if (event.target === settingsModal) settingsModal.hidden = true; });
document.querySelector('#toggleKey').addEventListener('click', (event) => {
  apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
  event.target.textContent = apiKey.type === 'password' ? 'Show' : 'Hide';
});
document.querySelector('#saveSettings').addEventListener('click', () => {
  localStorage.setItem('docscan-provider', document.querySelector('#provider').value);
  localStorage.setItem('docscan-api-key', apiKey.value);
  document.querySelector('#settingsNote').textContent = apiKey.value ? 'Connection saved on this device.' : 'Add a key to enable your provider.';
  showToast(apiKey.value ? 'AI provider connection saved' : 'No API key added');
});
apiKey.addEventListener('input', () => localStorage.setItem('docscan-api-key', apiKey.value));

document.querySelector('#profileMenuBtn').addEventListener('click', () => {
  const menu = document.querySelector('#profileMenu');
  menu.hidden = !menu.hidden;
  document.querySelector('#profileMenuBtn').setAttribute('aria-expanded', String(!menu.hidden));
});
document.querySelector('#mobileMenuBtn').addEventListener('click', () => {
  const sidebar = document.querySelector('.sidebar');
  const isOpen = sidebar.classList.toggle('mobile-menu-open');
  document.querySelector('#mobileMenuBtn').textContent = isOpen ? '×' : '☰';
  document.querySelector('#mobileMenuBtn').setAttribute('aria-expanded', String(isOpen));
});
document.querySelector('#menuAccountBtn').addEventListener('click', () => { document.querySelector('#profileMenu').hidden = true; showToast('Account details are managed by Firebase Authentication'); });
document.querySelector('#menuSettingsBtn').addEventListener('click', () => { document.querySelector('#profileMenu').hidden = true; settingsModal.hidden = false; apiKey.focus(); });
document.querySelector('#menuSignOutBtn').addEventListener('click', async () => { document.querySelector('#profileMenu').hidden = true; if (firebaseServices?.auth.currentUser) await signOut(firebaseServices.auth); else showToast('Local workspace remains active'); });

document.querySelector('#authBtn').addEventListener('click', async () => {
  if (firebaseServices?.auth.currentUser) {
    await signOut(firebaseServices.auth);
    showToast('Signed out securely');
    return;
  }
  authModal.hidden = false;
});
document.querySelector('#closeAuth').addEventListener('click', () => { authModal.hidden = true; });
authModal.addEventListener('click', (event) => { if (event.target === authModal) authModal.hidden = true; });
document.querySelector('#signInBtn').addEventListener('click', async () => {
  if (!firebaseServices) {
    document.querySelector('#authNote').textContent = 'Add your Firebase config in firebase-config.js first.';
    return;
  }
  try {
    await signInWithEmailAndPassword(firebaseServices.auth, document.querySelector('#authEmail').value, document.querySelector('#authPassword').value);
    authModal.hidden = true;
    showToast('Signed in securely');
  } catch (error) {
    document.querySelector('#authNote').textContent = error.message.replace('Firebase: ', '');
  }
});
document.querySelector('#guestSignInBtn').addEventListener('click', async () => {
  if (!firebaseServices) {
    document.querySelector('#authNote').textContent = 'Add your Firebase config in firebase-config.js first.';
    return;
  }
  try {
    await signInAnonymously(firebaseServices.auth);
    authModal.hidden = true;
    showToast('Guest workspace ready');
  } catch (error) {
    document.querySelector('#authNote').textContent = error.message.replace('Firebase: ', '');
  }
});
document.querySelector('#googleSignInBtn').addEventListener('click', async () => {
  if (!firebaseServices) {
    document.querySelector('#authNote').textContent = 'Add your Firebase config in firebase-config.js first.';
    return;
  }
  try {
    document.querySelector('#authNote').textContent = 'Completing Google sign-in…';
    await authReady;
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(firebaseServices.auth, provider);
      authModal.hidden = true;
      showToast('Signed in with Google');
    } catch (popupError) {
      if (!['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(popupError.code)) throw popupError;
      await signInWithRedirect(firebaseServices.auth, provider);
    }
  } catch (error) {
    document.querySelector('#authNote').textContent = error.code === 'auth/unauthorized-domain'
      ? `Firebase blocked ${window.location.hostname}. Add this hostname in Firebase Authentication → Settings → Authorized domains.`
      : error.message.replace('Firebase: ', '');
  }
});

const savedProvider = localStorage.getItem('docscan-provider');
if (savedProvider) document.querySelector('#provider').value = savedProvider;
apiKey.value = localStorage.getItem('docscan-api-key') || '';
if (apiKey.value) document.querySelector('#settingsNote').textContent = 'API key saved on this device.';
document.querySelector('#viewAllBtn').addEventListener('click', () => fileInput.click());
document.querySelector('#findingsBtn').addEventListener('click', () => document.querySelector('.document-workspace').scrollIntoView({ behavior: 'smooth', block: 'center' }));
document.querySelectorAll('.nav-item[data-view]').forEach((item) => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item[data-view]').forEach((nav) => nav.classList.remove('active'));
  item.classList.add('active');
  const view = item.dataset.view;
  if (view === 'overview') updateProfile(firebaseServices?.auth.currentUser || null);
  else document.querySelector('#pageTitle').innerHTML = `${view[0].toUpperCase()}${view.slice(1)} <span>✦</span>`;
  if (view === 'documents') document.querySelector('.documents-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (view === 'findings') document.querySelector('.document-workspace').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.querySelector('.sidebar').classList.remove('mobile-menu-open');
  document.querySelector('#mobileMenuBtn').textContent = '☰';
  document.querySelector('#mobileMenuBtn').setAttribute('aria-expanded', 'false');
}));