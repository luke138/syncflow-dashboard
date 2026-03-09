/**
 * SyncFlow — app.js
 * Google OAuth2 (GIS) + Sheets DB + Drive 연동
 * 주최자/팀원 구분, 초대 코드, 가입 승인 흐름 포함
 */

// ══════════════════════════════════════════════
// CONFIG  (본인 GCP 프로젝트 값으로 교체)
// ══════════════════════════════════════════════
const GOOGLE_CLIENT_ID =
  '221461527280-lqj3ih8nbucjpb8bj2eulj5r3anknt0h.apps.googleusercontent.com';
const GOOGLE_API_KEY = 'AIzaSyDNQ5eQEBLtluTNuetak1o6KT7LfGSzffc';

// Sheets API scope: spreadsheets + drive
const SCOPES =
  'https://www.googleapis.com/auth/spreadsheets ' +
  'https://www.googleapis.com/auth/drive';
const DISCOVERY_DOCS = [
  'https://sheets.googleapis.com/$discovery/rest?version=v4',
  'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
];

// Sheets 시트명 상수
const SH = {
  CONFIG:     'Config',
  MEMBERS:    'Members',
  INVITES:    'Invites',
  PROJECTS:   'Projects',
  TASKS:      'Tasks',
  MILESTONES: 'Milestones',
};

// ══════════════════════════════════════════════
// GLOBAL STATE
// ══════════════════════════════════════════════
let S = {
  // Google
  tokenClient:  null,
  accessToken:  null,
  gapiReady:    false,

  // 현재 사용자
  user:         null,   // { email, name, picture, role: 'owner'|'member', status: 'active'|'pending' }

  // 팀 구성 정보 (Sheets DB)
  sheetId:      null,   // Google Sheets 파일 ID
  driveRootId:  null,   // Drive 루트 폴더 ID
  teamName:     null,
  inviteCode:   null,

  // 앱 데이터
  db: { projects: [], tasks: [], milestones: [] },
  originalDb: null,
  activeProjectId: null,

  // URL 초대 파라미터
  inviteParam: null,
};

// 디바운스 큐
let syncQueue = [];
let syncTimer = null;

// ══════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════
const $ = id => document.getElementById(id);

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^(crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4)).toString(16));
}

function showToast(msg, duration = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

function showLoading(on, text = '처리 중...') {
  $('loading-overlay').style.display = on ? 'flex' : 'none';
  $('loading-text').textContent = text;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  $(id).classList.add('active');
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function parseInviteParam() {
  const p = new URLSearchParams(location.search);
  S.inviteParam = p.get('invite') || null;
}

// ══════════════════════════════════════════════
// GAPI INIT
// ══════════════════════════════════════════════
function initializeGapi() {
  if (typeof gapi === 'undefined') { setTimeout(initializeGapi, 150); return; }
  gapi.load('client', () => {
    gapi.client.init({ apiKey: GOOGLE_API_KEY, discoveryDocs: DISCOVERY_DOCS })
      .then(() => { S.gapiReady = true; })
      .catch(e => console.error('GAPI init error', e));
  });
}

// ══════════════════════════════════════════════
// AUTH — Google GIS
// ══════════════════════════════════════════════
function initAuth() {
  if (typeof google === 'undefined' || !google.accounts) {
    setTimeout(initAuth, 150);
    return;
  }

  // OAuth2 Token Client (Implicit flow)
  S.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: onTokenReceived,
    error_callback: (e) => {
      if (e.type !== 'popup_closed') {
        showToast('Google 로그인 오류: ' + (e.message || e.type));
      }
    },
  });

  // GIS One-Tap 버튼 렌더링
  try {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: () => triggerGoogleLogin(), // one-tap → OAuth token flow
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    google.accounts.id.renderButton($('gsi-btn-wrap'), {
      type: 'standard', shape: 'rectangular', theme: 'outline',
      text: 'signin_with', size: 'large', locale: 'ko', width: 320,
    });
  } catch(e) {
    $('gsi-btn-wrap').style.display = 'none';
  }
}

// 수동 Google 로그인 버튼
window.triggerGoogleLogin = function() {
  if (!S.tokenClient) {
    showToast('인증 모듈 로딩 중... 잠시 후 다시 시도하세요.');
    return;
  }
  S.tokenClient.requestAccessToken({ prompt: 'select_account' });
};

// 토큰 수신 콜백
async function onTokenReceived(tokenResp) {
  if (tokenResp.error) {
    showToast('로그인 실패: ' + tokenResp.error);
    return;
  }
  S.accessToken = tokenResp.access_token;

  // GAPI 준비 대기
  await waitGapi();
  gapi.client.setToken({ access_token: S.accessToken });

  showLoading(true, '사용자 정보 확인 중...');
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + S.accessToken },
    });
    const profile = await r.json();
    S.user = { email: profile.email, name: profile.name, picture: profile.picture };
    await afterLogin();
  } catch(e) {
    showToast('사용자 정보 로드 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
}

function waitGapi() {
  return new Promise(res => {
    const check = () => S.gapiReady ? res() : setTimeout(check, 100);
    check();
  });
}

// ══════════════════════════════════════════════
// LOGIN FLOW
// ══════════════════════════════════════════════

// 구글 로그인 후 분기점
async function afterLogin() {
  parseInviteParam();

  // localStorage에 저장된 시트 ID가 있는지 확인 (이전 세션)
  const savedSheetId = localStorage.getItem('sf_sheet_id');
  if (savedSheetId) {
    S.sheetId = savedSheetId;
    showLoading(true, '팀 정보 불러오는 중...');
    try {
      await loadTeamConfig();
      await checkMemberStatus();
    } catch(e) {
      // Sheet 접근 불가 → 초기 설정 화면
      localStorage.removeItem('sf_sheet_id');
      showRoleSelection();
    } finally {
      showLoading(false);
    }
    return;
  }

  // 초대 코드가 URL에 있으면
  if (S.inviteParam) {
    await handleInviteFlow();
    return;
  }

  // 신규 사용자 → 역할 선택
  showRoleSelection();
}

function showRoleSelection() {
  $('role-greeting').textContent = `안녕하세요, ${S.user.name.split(' ')[0]}님! 👋`;

  // 초대 코드가 있으면 팀원 카드 활성화
  if (S.inviteParam) {
    $('role-member-card').classList.remove('disabled');
    $('role-member-card').classList.add('enabled');
    $('role-member-tag').textContent = '초대 받은 팀에 합류하기';
  }
  showScreen('screen-role');
}

// 역할 선택
window.selectRole = function(role) {
  if (role === 'owner') {
    showScreen('screen-owner-setup');
    return;
  }
  // member
  if (!S.inviteParam) {
    showToast('초대 링크가 필요합니다. 주최자에게 초대 링크를 요청하세요.');
    return;
  }
  handleInviteFlow();
};

// ──────────────────────────────────────────────
// 주최자 설정
// ──────────────────────────────────────────────
window.completeOwnerSetup = async function() {
  const teamName  = $('owner-team-name').value.trim();
  const folderId  = $('owner-folder-id').value.trim();
  const sheetId   = $('owner-sheet-id').value.trim();

  if (!teamName || !folderId || !sheetId) {
    showToast('모든 항목을 입력해주세요.');
    return;
  }

  S.teamName    = teamName;
  S.driveRootId = folderId;
  S.sheetId     = sheetId;
  S.user.role   = 'owner';
  S.user.status = 'active';

  localStorage.setItem('sf_sheet_id', sheetId);

  showLoading(true, '팀 DB 초기화 중...');
  try {
    await initTeamSheets();
    await saveOwnerToSheet();
    enterApp();
  } catch(e) {
    showToast('설정 실패: ' + e.message);
    console.error(e);
  } finally {
    showLoading(false);
  }
};

// Sheets 시트 구조 초기화
async function initTeamSheets() {
  // 현재 시트 목록 조회
  const r = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: S.sheetId });
  const existing = r.result.sheets.map(s => s.properties.title);

  const needed = [SH.CONFIG, SH.MEMBERS, SH.INVITES, SH.PROJECTS, SH.TASKS, SH.MILESTONES];
  const toCreate = needed.filter(n => !existing.includes(n));

  if (toCreate.length > 0) {
    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: S.sheetId,
      resource: {
        requests: toCreate.map(title => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // 헤더 & 초기 Config 기록
  const inviteCode = uuid().substring(0, 8).toUpperCase();
  S.inviteCode = inviteCode;

  const data = [
    {
      range: `${SH.CONFIG}!A1`,
      values: [
        ['key', 'value'],
        ['teamName',    S.teamName],
        ['driveRootId', S.driveRootId],
        ['ownerEmail',  S.user.email],
        ['ownerName',   S.user.name],
        ['inviteCode',  inviteCode],
      ],
    },
    { range: `${SH.MEMBERS}!A1`,    values: [['email','name','picture','role','status','joinedAt']] },
    { range: `${SH.INVITES}!A1`,    values: [['code','createdAt','createdBy']] },
    { range: `${SH.PROJECTS}!A1`,   values: [['id','name','folderId']] },
    { range: `${SH.TASKS}!A1`,      values: [['id','projId','title','column','status']] },
    { range: `${SH.MILESTONES}!A1`, values: [['id','projId','title','date','status']] },
  ];

  await gapi.client.sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: S.sheetId,
    resource: { valueInputOption: 'USER_ENTERED', data },
  });

  // 초대 코드도 Invites 시트에 기록
  await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: S.sheetId,
    range: `${SH.INVITES}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [[inviteCode, new Date().toISOString(), S.user.email]] },
  });
}

async function saveOwnerToSheet() {
  await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: S.sheetId,
    range: `${SH.MEMBERS}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: {
      values: [[
        S.user.email, S.user.name, S.user.picture || '',
        'owner', 'active', new Date().toISOString(),
      ]],
    },
  });
}

// ──────────────────────────────────────────────
// 기존 팀 Config 로드
// ──────────────────────────────────────────────
async function loadTeamConfig() {
  const r = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: S.sheetId,
    range: `${SH.CONFIG}!A2:B10`,
  });
  const rows = r.result.values || [];
  const cfg = {};
  rows.forEach(([k, v]) => { cfg[k] = v; });

  S.teamName    = cfg.teamName    || '팀';
  S.driveRootId = cfg.driveRootId || '';
  S.inviteCode  = cfg.inviteCode  || '';
}

// ──────────────────────────────────────────────
// 멤버 상태 확인
// ──────────────────────────────────────────────
async function checkMemberStatus() {
  const r = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: S.sheetId,
    range: `${SH.MEMBERS}!A2:F`,
  });
  const rows = r.result.values || [];
  const me = rows.find(row => row[0] === S.user.email);

  if (!me) {
    // 이 시트의 멤버가 아님 → 역할 선택 or 초대 흐름
    if (S.inviteParam) {
      await handleInviteFlow();
    } else {
      showRoleSelection();
    }
    return;
  }

  S.user.role   = me[3] || 'member';
  S.user.status = me[4] || 'pending';

  if (S.user.status === 'pending') {
    showPendingScreen();
    return;
  }

  enterApp();
}

// ──────────────────────────────────────────────
// 초대 흐름
// ──────────────────────────────────────────────
async function handleInviteFlow() {
  const code = S.inviteParam;
  showLoading(true, '초대 정보 확인 중...');

  try {
    // 초대 코드로 Sheets ID를 찾아야 하는데,
    // 순수 클라이언트 앱이므로 inviteParam = "SheetID:CODE" 형식 사용
    const parts = code.split(':');
    if (parts.length !== 2) {
      showToast('유효하지 않은 초대 링크입니다.');
      showScreen('screen-start');
      return;
    }
    const [sheetId, inviteCode] = parts;
    S.sheetId = sheetId;
    localStorage.setItem('sf_sheet_id', sheetId);

    await loadTeamConfig();

    // 초대 코드 검증
    const ir = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: S.sheetId,
      range: `${SH.INVITES}!A2:C`,
    });
    const codes = (ir.result.values || []).map(r => r[0]);
    if (!codes.includes(inviteCode)) {
      showToast('초대 코드가 유효하지 않습니다.');
      localStorage.removeItem('sf_sheet_id');
      showScreen('screen-start');
      return;
    }

    S.inviteCode = inviteCode;
    showInviteConfirmScreen();
  } catch(e) {
    showToast('초대 확인 실패: ' + e.message);
    showScreen('screen-start');
  } finally {
    showLoading(false);
  }
}

function showInviteConfirmScreen() {
  $('invite-team-name').textContent = S.teamName;
  $('invite-owner-name').textContent = '주최자 승인 필요';
  $('invite-desc').textContent =
    `"${S.teamName}" 팀에 가입 신청을 하시겠습니까?\n주최자의 승인 후 대시보드를 사용할 수 있습니다.`;
  showScreen('screen-invite-confirm');
}

window.submitJoinRequest = async function() {
  showLoading(true, '가입 신청 중...');
  try {
    // Members 시트에 pending 상태로 추가
    await gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: S.sheetId,
      range: `${SH.MEMBERS}!A2`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [[
          S.user.email, S.user.name, S.user.picture || '',
          'member', 'pending', new Date().toISOString(),
        ]],
      },
    });
    S.user.role   = 'member';
    S.user.status = 'pending';
    showPendingScreen();
    showToast('가입 신청이 완료되었습니다! 주최자의 승인을 기다려주세요.');
  } catch(e) {
    showToast('신청 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

window.rejectInvite = function() {
  localStorage.removeItem('sf_sheet_id');
  S.sheetId = null;
  history.replaceState({}, '', location.pathname);
  showScreen('screen-start');
};

function showPendingScreen() {
  $('pending-team-label').textContent = S.teamName || '팀';
  showScreen('screen-pending');
}

window.checkApprovalStatus = async function() {
  showLoading(true, '상태 확인 중...');
  try {
    await checkMemberStatus();
  } catch(e) {
    showToast('확인 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

// ──────────────────────────────────────────────
// 데모 로그인
// ──────────────────────────────────────────────
window.demoLogin = function() {
  S.user = {
    email: 'demo@syncflow.io',
    name: '김대표 (데모)',
    picture: 'https://ui-avatars.com/api/?name=CEO&background=4f46e5&color=fff&size=128',
    role: 'owner',
    status: 'active',
  };
  S.teamName    = '데모팀';
  S.driveRootId = 'demo';
  S.sheetId     = 'demo';
  S.inviteCode  = 'DEMO0000';
  seedDemoData();
  enterApp();
  showToast('데모 모드입니다. Drive/Sheets 연동은 비활성화됩니다.');
};

function seedDemoData() {
  const pid1 = uuid(), pid2 = uuid();
  S.db.projects = [
    { id: pid1, name: '모바일 앱 v2.0', folderId: 'demo-folder-1' },
    { id: pid2, name: '마케팅 캠페인 Q3', folderId: 'demo-folder-2' },
  ];
  S.db.tasks = [
    { id: uuid(), projId: pid1, title: '경쟁사 분석 리포트', column: 'TODO',  status: '승인 대기', due: '', assignee: '김기획' },
    { id: uuid(), projId: pid1, title: 'UI/UX 시안 디자인',  column: 'DOING', status: '승인 완료', due: '', assignee: '박디자인' },
    { id: uuid(), projId: pid1, title: '서버 아키텍처 설계',  column: 'DONE',  status: '승인 완료', due: '', assignee: '이개발' },
    { id: uuid(), projId: pid2, title: '광고 소재 제작',      column: 'TODO',  status: '승인 대기', due: '', assignee: '' },
    { id: uuid(), projId: pid2, title: '인플루언서 섭외',     column: 'DOING', status: '승인 대기', due: '', assignee: '' },
  ];
  const future = n => new Date(Date.now() + n*24*3600*1000).toISOString().split('T')[0];
  S.db.milestones = [
    { id: uuid(), projId: pid1, title: '클로즈 베타', date: future(14), status: '승인 대기' },
    { id: uuid(), projId: pid1, title: '정식 출시',   date: future(45), status: '승인 대기' },
  ];
  S.activeProjectId = pid1;
  S.originalDb = deepClone(S.db);
}

// ══════════════════════════════════════════════
// APP ENTRY
// ══════════════════════════════════════════════
function enterApp() {
  // 사용자 UI 업데이트
  $('user-avatar').src = S.user.picture || `https://ui-avatars.com/api/?name=${encodeURIComponent(S.user.name)}&background=4f46e5&color=fff`;
  $('user-name').textContent  = S.user.name;
  $('user-email').textContent = S.user.email;
  $('user-role-badge').textContent = S.user.role === 'owner' ? '주최자' : '팀원';

  // 주최자 패널 표시
  if (S.user.role === 'owner') {
    $('owner-panel').style.display = 'block';
    checkPendingRequests();
  }

  showScreen('screen-app');

  // 데이터 로드 (데모가 아닌 경우)
  if (S.sheetId !== 'demo') {
    loadAllData();
  } else {
    renderAll();
  }
}

// ══════════════════════════════════════════════
// SHEETS DB  (Granular Sync)
// ══════════════════════════════════════════════
async function loadAllData() {
  showLoading(true, '데이터 불러오는 중...');
  try {
    const r = await gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: S.sheetId,
      ranges: [
        `${SH.PROJECTS}!A2:C`,
        `${SH.TASKS}!A2:E`,
        `${SH.MILESTONES}!A2:E`,
      ],
    });
    const [pr, tr, mr] = r.result.valueRanges;

    S.db.projects   = (pr.values || []).filter(r=>r[0]).map(r=>({ id:r[0], name:r[1], folderId:r[2] }));
    S.db.tasks      = (tr.values || []).filter(r=>r[0]).map(r=>({ id:r[0], projId:r[1], title:r[2], column:r[3], status:r[4] }));
    S.db.milestones = (mr.values || []).filter(r=>r[0]).map(r=>({ id:r[0], projId:r[1], title:r[2], date:r[3],   status:r[4] }));

    if (S.db.projects.length > 0 && !S.activeProjectId) {
      S.activeProjectId = S.db.projects[0].id;
    }
    S.originalDb = deepClone(S.db);
    renderAll();
  } catch(e) {
    showToast('데이터 로드 실패: ' + e.message);
    console.error(e);
  } finally {
    showLoading(false);
  }
}

// Debounced sync queue
function queueSync(action) {
  syncQueue.push(action);
  $('loading-overlay').style.display = 'flex';
  $('loading-text').textContent = '변경 사항 저장 중...';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSyncQueue, 2500);
}

async function flushSyncQueue() {
  if (!syncQueue.length || S.sheetId === 'demo') {
    showLoading(false);
    return;
  }
  const batch = [...syncQueue];
  syncQueue = [];

  try {
    // ID 목록 가져오기
    const snap = await gapi.client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: S.sheetId,
      ranges: [`${SH.PROJECTS}!A:A`, `${SH.TASKS}!A:A`, `${SH.MILESTONES}!A:A`],
    });
    const ids = {
      Projects:   (snap.result.valueRanges[0].values || []).map(r=>r[0]),
      Tasks:      (snap.result.valueRanges[1].values || []).map(r=>r[0]),
      Milestones: (snap.result.valueRanges[2].values || []).map(r=>r[0]),
    };

    let updates = [];
    let appends = { Projects:[], Tasks:[], Milestones:[] };

    batch.forEach(({ sheet, data, isNew }) => {
      const idx = ids[sheet].indexOf(data[0]);
      if (isNew || idx === -1) {
        appends[sheet].push(data);
      } else {
        const row = idx + 1;
        const colMap = { Projects:'C', Tasks:'E', Milestones:'E' };
        updates.push({ range:`${sheet}!A${row}:${colMap[sheet]}${row}`, values:[data] });
      }
    });

    if (updates.length) {
      await gapi.client.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: S.sheetId,
        resource: { valueInputOption:'USER_ENTERED', data: updates },
      });
    }
    for (const sheet of Object.keys(appends)) {
      if (appends[sheet].length) {
        await gapi.client.sheets.spreadsheets.values.append({
          spreadsheetId: S.sheetId,
          range: `${sheet}!A1`,
          valueInputOption:'USER_ENTERED',
          insertDataOption:'INSERT_ROWS',
          resource: { values: appends[sheet] },
        });
      }
    }
    S.originalDb = deepClone(S.db);
    showToast('저장 완료 🟢');
  } catch(e) {
    showToast('저장 실패, 롤백합니다: ' + e.message);
    S.db = deepClone(S.originalDb);
    renderAll();
  } finally {
    showLoading(false);
  }
}

// ══════════════════════════════════════════════
// RENDERING
// ══════════════════════════════════════════════
const STATUS_CLS = { '승인 대기':'pending', '승인 완료':'approved', '반려':'rejected' };

function renderAll() {
  renderPendingBar();
  renderSidebar();
  renderMain();
}

function renderPendingBar() {
  const el = $('pending-marquee');
  const all = [
    ...S.db.tasks.filter(t=>t.status==='승인 대기'),
    ...S.db.milestones.filter(m=>m.status==='승인 대기'),
  ];
  if (!all.length) {
    el.innerHTML = '<span style="opacity:0.5">대기 중인 안건이 없습니다 🎉</span>';
    return;
  }
  el.innerHTML = all.map(item => `
    <div class="pending-item">
      <span class="badge pending">🟡 대기</span>
      <span>${item.title}</span>
      <button onclick="copyKakao('${item.projId}','${item.title.replace(/'/g,"\\'")}','${item.status}')"
        style="background:none;border:none;cursor:pointer;font-size:1rem;padding:0 4px" title="카카오 공유">💬</button>
    </div>
  `).join('<span style="color:#cbd5e1">›</span>');
}

function renderSidebar() {
  const list = $('project-list');
  $('project-count').textContent = S.db.projects.length;
  list.innerHTML = S.db.projects.map(p => `
    <div class="project-item ${p.id===S.activeProjectId?'active':''}"
         onclick="selectProject('${p.id}')">📁 ${p.name}</div>
  `).join('');
}

function renderMain() {
  const proj = S.db.projects.find(p=>p.id===S.activeProjectId);
  if (!proj) {
    $('current-project-title').innerHTML = '<span style="color:var(--primary)">📁</span> 프로젝트를 선택하세요';
    $('current-folder-label').textContent = '';
    return;
  }
  $('current-project-title').innerHTML = `<span style="color:var(--primary)">📁</span> ${proj.name}`;
  $('current-folder-label').textContent = `Drive Folder: ${proj.folderId}`;

  renderProgress(proj.id);
  renderConfirmDashboard(proj.id);
  renderKanban(proj.id);
  if (S.sheetId !== 'demo') fetchDriveFiles(proj.folderId);
}

function renderProgress(projId) {
  const tasks = S.db.tasks.filter(t=>t.projId===projId);
  const done  = tasks.filter(t=>t.column==='DONE').length;
  const pct   = tasks.length ? Math.round(done/tasks.length*100) : 0;
  $('progress-percent').textContent = pct + '%';
  $('progress-circle').setAttribute('stroke-dasharray', `${pct},100`);
}

function renderMilestones(projId) {
  const el = $('milestone-list');
  const ms = S.db.milestones.filter(m=>m.projId===projId).sort((a,b)=>new Date(a.date)-new Date(b.date));
  if (!ms.length) { el.innerHTML = '<p style="color:var(--muted);font-size:0.82rem;flex:1;display:flex;align-items:center">등록된 마일스톤 없음</p>'; return; }
  el.innerHTML = ms.map(m => {
    const d = Math.ceil((new Date(m.date)-new Date())/(86400000));
    const dd = d>0?`D-${d}`:d===0?'D-Day':`D+${Math.abs(d)}`;
    const cls = m.status==='승인 완료'?'done':m.status==='승인 대기'?'active':'';
    return `<div class="ms-node">
      <div class="ms-circle ${cls}" onclick="toggleStatus('milestone','${m.id}')" title="${m.status}"></div>
      <div class="ms-node-info"><strong>${m.title}</strong><span>${dd}</span></div>
    </div>`;
  }).join('');
}

function renderConfirmDashboard(projId) {
  const statPending  = $('stat-pending');
  const statApproved = $('stat-approved');
  const statRejected = $('stat-rejected');
  const listEl       = $('confirm-item-list');
  if (!statPending) return;

  const items = [
    ...S.db.tasks.filter(t=>t.projId===projId),
    ...S.db.milestones.filter(m=>m.projId===projId),
  ];
  statPending.textContent  = items.filter(i=>i.status==='승인 대기').length;
  statApproved.textContent = items.filter(i=>i.status==='승인 완료').length;
  statRejected.textContent = items.filter(i=>i.status==='반려').length;

  if (!items.length) {
    listEl.innerHTML = '<span style="color:var(--muted);font-size:0.8rem">안건이 없습니다</span>';
    return;
  }
  listEl.innerHTML = items.slice(0,8).map(item => {
    const cls  = STATUS_CLS[item.status]||'pending';
    const type = item.column ? '태스크' : '마일스톤';
    const kind = item.column ? 'task' : 'milestone';
    return `<div class="confirm-row">
      <span class="confirm-type-tag">${type}</span>
      <span class="confirm-title">${item.title}</span>
      <select class="status-dropdown ${cls}" onchange="changeItemStatus('${kind}','${item.id}',this.value)">
        <option value="승인 대기"  ${item.status==='승인 대기' ?'selected':''}>🟡 대기</option>
        <option value="승인 완료" ${item.status==='승인 완료'?'selected':''}>🟢 승인</option>
        <option value="반려"       ${item.status==='반려'      ?'selected':''}>🔴 반려</option>
      </select>
    </div>`;
  }).join('');
}

function renderKanban(projId) {
  ['TODO','DOING','DONE'].forEach(col => {
    const tasks = S.db.tasks.filter(t=>t.projId===projId && t.column===col);
    $(`count-${col}`).textContent = tasks.length;
    $(`col-${col}`).innerHTML = tasks.map(t => `
      <div class="kanban-card" draggable="true" ondragstart="drag(event,'${t.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px">
          <h4>${t.title}</h4>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="card-icon-btn" onclick="openTaskEdit('${t.id}')" title="편집">✏️</button>
            <button class="card-icon-btn card-delete-btn" onclick="deleteTask('${t.id}')" title="삭제">🗑️</button>
          </div>
        </div>
        <div class="card-meta">
          <div class="card-meta-info">
            <span>마감: ${t.due||'지정 안됨'}</span>
            <span>담당: ${t.assignee||'미정'}</span>
          </div>
          <img src="https://ui-avatars.com/api/?name=${encodeURIComponent((t.assignee||t.title)[0])}&background=random&size=32"
               style="width:28px;height:28px;border-radius:50%" alt="a">
        </div>
        <div class="card-footer">
          <a class="card-link" href="https://drive.google.com" target="_blank">
            <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" alt="D">
            파일 보기
          </a>
          <select class="status-dropdown ${STATUS_CLS[t.status]||'pending'}"
                  onchange="changeTaskStatus('${t.id}',this.value)"
                  onclick="event.stopPropagation()">
            <option value="승인 대기"  ${t.status==='승인 대기' ?'selected':''}>🟡 승인 대기</option>
            <option value="승인 완료" ${t.status==='승인 완료'?'selected':''}>🟢 승인 완료</option>
            <option value="반려"       ${t.status==='반려'      ?'selected':''}>🔴 반려</option>
          </select>
        </div>
      </div>
    `).join('');
  });
}

// ══════════════════════════════════════════════
// USER INTERACTIONS
// ══════════════════════════════════════════════

window.changeTaskStatus = function(id, status) {
  const task = S.db.tasks.find(t=>t.id===id);
  if (!task) return;
  task.status = status;
  renderAll();
  queueSync({ sheet:'Tasks', data:[task.id,task.projId,task.title,task.column,task.status,task.due||'',task.assignee||''], isNew:false });
};

window.changeItemStatus = function(type, id, status) {
  const list = type==='task' ? S.db.tasks : S.db.milestones;
  const item = list.find(i=>i.id===id);
  if (!item) return;
  item.status = status;
  renderAll();
  const sheet = type==='task' ? 'Tasks' : 'Milestones';
  const data  = type==='task'
    ? [item.id,item.projId,item.title,item.column,item.status,item.due||'',item.assignee||'']
    : [item.id,item.projId,item.title,item.date,item.status];
  queueSync({ sheet, data, isNew:false });
};

window.deleteTask = function(id) {
  if (!confirm('이 태스크를 삭제할까요?')) return;
  S.db.tasks = S.db.tasks.filter(t=>t.id!==id);
  renderAll();
  if (S.sheetId !== 'demo') showToast('태스크가 삭제되었습니다.');
};

let _editTaskId = null;
window.openTaskEdit = function(id) {
  const task = S.db.tasks.find(t=>t.id===id);
  if (!task) return;
  _editTaskId = id;
  $('edit-task-title').value    = task.title;
  $('edit-task-due').value      = task.due||'';
  $('edit-task-assignee').value = task.assignee||'';
  $('edit-task-status').value   = task.status;
  $('modal-task-edit').style.display = 'flex';
};

window.saveTaskEdit = function() {
  const task = S.db.tasks.find(t=>t.id===_editTaskId);
  if (!task) return;
  // 값을 먼저 읽고 나서 모달 닫기
  const newTitle    = $('edit-task-title').value.trim();
  const newDue      = $('edit-task-due').value;
  const newAssignee = $('edit-task-assignee').value.trim();
  const newStatus   = $('edit-task-status').value;

  task.title    = newTitle || task.title;
  task.due      = newDue;
  task.assignee = newAssignee;
  task.status   = newStatus;

  $('modal-task-edit').style.display = 'none';
  renderAll();
  queueSync({ sheet:'Tasks', data:[task.id,task.projId,task.title,task.column,task.status,task.due,task.assignee], isNew:false });
};
window.selectProject = function(id) {
  S.activeProjectId = id;
  renderSidebar();
  renderMain();
  closeSidebar();
};

window.toggleStatus = function(type, id) {
  const list = type==='task' ? S.db.tasks : S.db.milestones;
  const item = list.find(i=>i.id===id);
  if (!item) return;
  const cycle = ['승인 대기','승인 완료','반려'];
  item.status = cycle[(cycle.indexOf(item.status)+1)%3];
  renderAll();
  const sheet = type==='task'?'Tasks':'Milestones';
  const data  = type==='task'
    ? [item.id,item.projId,item.title,item.column,item.status]
    : [item.id,item.projId,item.title,item.date,item.status];
  queueSync({ sheet, data, isNew:false });
};

window.drag = (ev, id) => ev.dataTransfer.setData('taskId', id);
window.allowDrop = ev => ev.preventDefault();
window.drop = function(ev, col) {
  ev.preventDefault();
  const task = S.db.tasks.find(t=>t.id===ev.dataTransfer.getData('taskId'));
  if (task && task.column!==col) {
    task.column = col;
    renderMain();
    queueSync({ sheet:'Tasks', data:[task.id,task.projId,task.title,task.column,task.status], isNew:false });
  }
};

window.addTask = function() {
  if (!S.activeProjectId) { showToast('프로젝트를 먼저 선택하세요.'); return; }
  const title = prompt('새 태스크 제목:');
  if (!title?.trim()) return;
  const id = uuid();
  const task = { id, projId:S.activeProjectId, title:title.trim(), column:'TODO', status:'승인 대기' };
  S.db.tasks.push(task);
  renderAll();
  queueSync({ sheet:'Tasks', data:[id,task.projId,task.title,task.column,task.status], isNew:true });
};

window.createNewProject = async function() {
  const name = prompt('새 프로젝트 이름:');
  if (!name?.trim()) return;

  const id = uuid();
  let folderId = S.driveRootId;

  // Drive에 폴더 생성 (데모 아닌 경우)
  if (S.sheetId !== 'demo' && S.driveRootId && S.driveRootId !== 'demo') {
    showLoading(true, 'Drive 폴더 생성 중...');
    try {
      const r = await gapi.client.drive.files.create({
        resource: { name:name.trim(), mimeType:'application/vnd.google-apps.folder', parents:[S.driveRootId] },
        fields: 'id',
      });
      folderId = r.result.id;
    } catch(e) {
      showToast('폴더 생성 실패: ' + e.message);
    } finally {
      showLoading(false);
    }
  }

  S.db.projects.push({ id, name:name.trim(), folderId });
  S.activeProjectId = id;
  S.db.tasks.push({ id:uuid(), projId:id, title:'첫 태스크 추가하기', column:'TODO', status:'승인 대기' });
  renderAll();
  queueSync({ sheet:'Projects', data:[id,name.trim(),folderId], isNew:true });
};

window.copyKakao = function(projId, title, status) {
  const proj = S.db.projects.find(p=>p.id===projId);
  const text = `🚨 [CEO 결재 요청]\n\n🏢 프로젝트: ${proj?.name||'?'}\n✅ 안건: ${title}\n📊 상태: ${status}\n\n🔗 대시보드: ${location.href}`;
  navigator.clipboard.writeText(text)
    .then(() => showToast('카카오톡 공유용 텍스트가 복사되었습니다!'))
    .catch(() => showToast('클립보드 복사 실패'));
};

// ──────────────────────────────────────────────
// Drive 파일 목록
// ──────────────────────────────────────────────
async function fetchDriveFiles(folderId) {
  const el = $('drive-files');
  if (!folderId || folderId==='demo' || folderId==='신규 생성 대기') {
    el.innerHTML = '<span style="color:var(--muted);font-size:0.82rem">연결된 Drive 폴더가 없습니다.</span>';
    return;
  }
  el.innerHTML = '<span style="color:var(--muted);font-size:0.82rem">로딩 중...</span>';
  try {
    const r = await gapi.client.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,webViewLink,modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    const files = r.result.files || [];
    if (!files.length) {
      el.innerHTML = '<span style="color:var(--muted);font-size:0.82rem">파일이 없습니다. 파일을 업로드하거나 리포트를 내보내보세요.</span>';
      return;
    }
    el.innerHTML = files.map(f => {
      const icon = f.mimeType.includes('spreadsheet')?'📊':f.mimeType.includes('document')?'📝':f.mimeType.includes('presentation')?'💡':'📄';
      const bg   = f.mimeType.includes('spreadsheet')?'bg-sheets':f.mimeType.includes('document')?'bg-docs':f.mimeType.includes('presentation')?'bg-slides':'bg-other';
      const mod  = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('ko-KR') : '';
      return `<div class="drive-file-card">
        <div class="file-card-main" onclick="window.open('${f.webViewLink}','_blank')">
          <div class="file-icon ${bg}">${icon}</div>
          <div class="file-info"><p title="${f.name}">${f.name}</p><span>${mod}</span></div>
        </div>
        <div class="file-card-actions">
          <button class="file-action-btn" onclick="window.open('${f.webViewLink}','_blank')" title="열기">🔗</button>
          <button class="file-action-btn file-del-btn" onclick="deleteDriveFile('${f.id}','${folderId}')" title="삭제">🗑️</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red);font-size:0.82rem">파일 목록 로드 실패</span>';
  }
}

window.triggerFileUpload = function() {
  const proj = S.db.projects.find(p=>p.id===S.activeProjectId);
  if (!proj) { showToast('프로젝트를 먼저 선택하세요.'); return; }
  if (S.sheetId === 'demo') { showToast('데모 모드에서는 파일 업로드가 불가합니다.'); return; }
  $('file-upload-input').click();
};

window.uploadFilesToDrive = async function(files) {
  const proj = S.db.projects.find(p=>p.id===S.activeProjectId);
  if (!proj || !files.length) return;
  showLoading(true, `파일 업로드 중... (0/${files.length})`);
  let done = 0;
  for (const file of Array.from(files)) {
    try {
      const meta = JSON.stringify({ name: file.name, parents: [proj.folderId] });
      const form = new FormData();
      form.append('metadata', new Blob([meta], { type: 'application/json' }));
      form.append('file', file);
      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + S.accessToken },
        body: form,
      });
      done++;
      $('loading-text').textContent = `파일 업로드 중... (${done}/${files.length})`;
    } catch(e) {
      showToast(`${file.name} 업로드 실패: ${e.message}`);
    }
  }
  showLoading(false);
  showToast(`✅ ${done}개 파일 업로드 완료!`);
  fetchDriveFiles(proj.folderId);
  $('file-upload-input').value = '';
};

window.deleteDriveFile = async function(fileId, folderId) {
  if (!confirm('이 파일을 Drive에서 삭제할까요?\n(휴지통으로 이동됩니다)')) return;
  showLoading(true, '파일 삭제 중...');
  try {
    await gapi.client.drive.files.delete({ fileId });
    showToast('파일이 삭제되었습니다.');
    fetchDriveFiles(folderId);
  } catch(e) {
    showToast('삭제 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

// ──────────────────────────────────────────────
// 리포트 내보내기 (서식 있는 Sheets)
// ──────────────────────────────────────────────
window.exportReport = async function() {
  const proj = S.db.projects.find(p=>p.id===S.activeProjectId);
  if (!proj) { showToast('프로젝트를 선택하세요.'); return; }
  if (S.sheetId==='demo') { showToast('데모 모드에서는 Drive 저장이 불가합니다.'); return; }
  if (!confirm(`[${proj.name}] 리포트를 Google Drive에 저장할까요?`)) return;

  showLoading(true, '리포트 생성 중...');
  try {
    const today = new Date().toISOString().split('T')[0];
    const tasks = S.db.tasks.filter(t=>t.projId===proj.id);
    const ms    = S.db.milestones.filter(m=>m.projId===proj.id);
    const pct   = tasks.length ? Math.round(tasks.filter(t=>t.column==='DONE').length/tasks.length*100) : 0;

    const cr = await gapi.client.drive.files.create({
      resource: {
        name:`[리포트] ${proj.name}_${today}`,
        mimeType:'application/vnd.google-apps.spreadsheet',
        parents:[proj.folderId],
      },
      fields:'id,webViewLink',
    });
    const sid = cr.result.id;

    const values = [
      ['📊 SyncFlow 프로젝트 리포트','','',''],
      ['프로젝트',proj.name,'',''],
      ['팀',S.teamName||'-','',''],
      ['생성일',today,'',''],
      ['진척률',pct+'%','',''],
      ['','','',''],
      ['📋 태스크 목록','','',''],
      ['#','태스크명','칸반 상태','CEO 결재'],
      ...tasks.map((t,i)=>[i+1,t.title,t.column,t.status]),
      ['','','',''],
      ['🏁 마일스톤','','',''],
      ['#','마일스톤','목표일','결재 상태'],
      ...ms.map((m,i)=>[i+1,m.title,m.date,m.status]),
    ];

    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId:sid, range:'Sheet1!A1',
      valueInputOption:'USER_ENTERED', resource:{values},
    });

    // 서식 적용
    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: sid,
      resource: { requests: [
        { repeatCell: { range:{sheetId:0,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:4},
          cell:{userEnteredFormat:{backgroundColor:{red:0.29,green:0.42,blue:0.98},textFormat:{bold:true,fontSize:14,foregroundColor:{red:1,green:1,blue:1}}}},
          fields:'userEnteredFormat(backgroundColor,textFormat)' }},
        { repeatCell: { range:{sheetId:0,startRowIndex:7,endRowIndex:8,startColumnIndex:0,endColumnIndex:4},
          cell:{userEnteredFormat:{backgroundColor:{red:0.88,green:0.92,blue:1},textFormat:{bold:true}}},
          fields:'userEnteredFormat(backgroundColor,textFormat)' }},
        { autoResizeDimensions:{dimensions:{sheetId:0,dimension:'COLUMNS',startIndex:0,endIndex:4}} },
      ]},
    });

    showToast('✅ 리포트 저장 완료!');
    fetchDriveFiles(proj.folderId);
  } catch(e) {
    showToast('리포트 생성 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

// ══════════════════════════════════════════════
// 주최자 전용: 초대 & 가입 관리
// ══════════════════════════════════════════════
window.showInviteModal = function() {
  const base = location.origin + location.pathname;
  const link = `${base}?invite=${S.sheetId}:${S.inviteCode}`;
  $('invite-link-text').value = link;
  $('modal-invite').style.display = 'flex';
};

window.closeModal = id => { $(id).style.display = 'none'; };

window.copyInviteLink = function() {
  navigator.clipboard.writeText($('invite-link-text').value)
    .then(() => showToast('초대 링크가 복사되었습니다!'))
    .catch(() => showToast('복사 실패'));
};

window.shareKakao = function() {
  const text = `[SyncFlow 팀 초대]\n${S.teamName} 팀에 초대합니다.\n아래 링크로 접속 후 가입 신청하세요:\n${$('invite-link-text').value}`;
  navigator.clipboard.writeText(text).then(() => showToast('카카오톡 공유 텍스트가 복사되었습니다!'));
};

window.regenerateInviteCode = async function() {
  if (!confirm('새 초대 코드를 생성하면 기존 링크는 무효화됩니다. 계속할까요?')) return;
  if (S.sheetId === 'demo') { showToast('데모 모드에서는 사용 불가합니다.'); return; }
  showLoading(true);
  try {
    const code = uuid().substring(0,8).toUpperCase();
    S.inviteCode = code;
    // Config 시트의 inviteCode 값 업데이트
    const cr = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId:S.sheetId, range:`${SH.CONFIG}!A2:A10`,
    });
    const rows = cr.result.values || [];
    const rowIdx = rows.findIndex(r=>r[0]==='inviteCode');
    if (rowIdx !== -1) {
      await gapi.client.sheets.spreadsheets.values.update({
        spreadsheetId:S.sheetId, range:`${SH.CONFIG}!B${rowIdx+2}`,
        valueInputOption:'USER_ENTERED', resource:{values:[[code]]},
      });
    }
    // Invites 시트에도 추가
    await gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId:S.sheetId, range:`${SH.INVITES}!A2`,
      valueInputOption:'USER_ENTERED', insertDataOption:'INSERT_ROWS',
      resource:{values:[[code, new Date().toISOString(), S.user.email]]},
    });
    showInviteModal();
    showToast('새 초대 코드가 생성되었습니다.');
  } catch(e) {
    showToast('생성 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

// 가입 신청 목록 모달
window.showMemberRequests = async function() {
  $('modal-requests').style.display = 'flex';
  $('request-list').innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px">로딩 중...</p>';

  if (S.sheetId === 'demo') {
    $('request-list').innerHTML = `
      <div class="request-item">
        <img class="request-avatar" src="https://ui-avatars.com/api/?name=홍길동&background=4f46e5&color=fff">
        <div class="request-info">
          <strong>홍길동</strong>
          <span>hong@example.com · 가입 신청 중</span>
        </div>
        <div class="request-actions">
          <button class="btn-approve" onclick="showToast('데모 모드에서는 승인이 불가합니다.')">✓ 승인</button>
          <button class="btn-reject" onclick="showToast('데모 모드에서는 반려가 불가합니다.')">✕ 반려</button>
        </div>
      </div>`;
    return;
  }

  try {
    const r = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId:S.sheetId, range:`${SH.MEMBERS}!A2:F`,
    });
    const pending = (r.result.values||[]).filter(row=>row[4]==='pending');
    if (!pending.length) {
      $('request-list').innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px">대기 중인 신청이 없습니다</p>';
      return;
    }
    $('request-list').innerHTML = pending.map(row => `
      <div class="request-item" id="req-${row[0].replace(/[@.]/g,'_')}">
        <img class="request-avatar" src="${row[2]||`https://ui-avatars.com/api/?name=${encodeURIComponent(row[1])}&background=64748b&color=fff`}">
        <div class="request-info">
          <strong>${row[1]}</strong>
          <span>${row[0]}</span>
        </div>
        <div class="request-actions">
          <button class="btn-approve" onclick="approveRequest('${row[0]}')">✓ 승인</button>
          <button class="btn-reject" onclick="rejectRequest('${row[0]}')">✕ 반려</button>
        </div>
      </div>
    `).join('');
    $('request-badge').style.display = pending.length ? 'block' : 'none';
  } catch(e) {
    $('request-list').innerHTML = '<p style="color:var(--red);text-align:center;padding:20px">로드 실패: '+e.message+'</p>';
  }
};

async function updateMemberStatus(email, status) {
  const r = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId:S.sheetId, range:`${SH.MEMBERS}!A:A`,
  });
  const rows = r.result.values || [];
  const idx = rows.findIndex(r=>r[0]===email);
  if (idx === -1) return;
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId:S.sheetId, range:`${SH.MEMBERS}!E${idx+1}`,
    valueInputOption:'USER_ENTERED', resource:{values:[[status]]},
  });
}

window.approveRequest = async function(email) {
  showLoading(true, '승인 중...');
  try {
    await updateMemberStatus(email, 'active');
    const key = email.replace(/[@.]/g,'_');
    const el = $(`req-${key}`);
    if (el) el.remove();
    showToast(`${email} 승인 완료!`);
    checkPendingRequests();
  } catch(e) {
    showToast('승인 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

window.rejectRequest = async function(email) {
  if (!confirm(`${email}의 가입 신청을 반려할까요?`)) return;
  showLoading(true, '처리 중...');
  try {
    await updateMemberStatus(email, 'rejected');
    const key = email.replace(/[@.]/g,'_');
    const el = $(`req-${key}`);
    if (el) el.remove();
    showToast(`${email} 가입 반려`);
    checkPendingRequests();
  } catch(e) {
    showToast('처리 실패: ' + e.message);
  } finally {
    showLoading(false);
  }
};

async function checkPendingRequests() {
  if (S.sheetId === 'demo') return;
  try {
    const r = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId:S.sheetId, range:`${SH.MEMBERS}!E2:E`,
    });
    const pending = (r.result.values||[]).filter(r=>r[0]==='pending');
    $('request-badge').style.display = pending.length ? 'block' : 'none';
  } catch(_) {}
}

// ══════════════════════════════════════════════
// 필요 물품 관리
// ══════════════════════════════════════════════
let _supplyCounter = 10;

window.addSupplyItem = function() {
  const name = prompt('물품 이름:');
  if (!name?.trim()) return;
  const assignee = prompt('담당자 (선택사항):') || '';
  const id = 's' + (++_supplyCounter);
  const li = document.createElement('li');
  li.className = 'supply-item';
  li.dataset.id = id;
  li.innerHTML = `
    <input type="checkbox" onchange="toggleSupply('${id}',this)">
    <span class="supply-name">${name.trim()}</span>
    ${assignee ? `<span class="assignee">- ${assignee}</span>` : ''}
    <button class="supply-del-btn" onclick="deleteSupply('${id}')">✕</button>
  `;
  $('supply-list').appendChild(li);
  showToast('물품이 추가되었습니다.');
};

window.deleteSupply = function(id) {
  const li = document.querySelector(`[data-id="${id}"]`);
  if (li) { li.remove(); showToast('물품이 삭제되었습니다.'); }
};

window.toggleSupply = function(id, cb) {
  const li = document.querySelector(`[data-id="${id}"]`);
  if (li) li.style.opacity = cb.checked ? '0.5' : '1';
};

// ══════════════════════════════════════════════
// 마일스톤 추가
// ══════════════════════════════════════════════
window.addMilestone = function() {
  if (!S.activeProjectId) { showToast('프로젝트를 먼저 선택하세요.'); return; }
  const title = prompt('마일스톤 이름:');
  if (!title?.trim()) return;
  const date = prompt('목표일 (YYYY-MM-DD):');
  if (!date) return;
  const id = uuid();
  const ms = { id, projId: S.activeProjectId, title: title.trim(), date, status: '승인 대기' };
  S.db.milestones.push(ms);
  renderAll();
  queueSync({ sheet:'Milestones', data:[id, ms.projId, ms.title, ms.date, ms.status], isNew:true });
};

// ══════════════════════════════════════════════
// 뒤로가기
// ══════════════════════════════════════════════
window.goBack = function(screenId) {
  showScreen(screenId);
};
window.toggleSidebar = function() {
  $('sidebar').classList.toggle('open');
  $('sidebar-overlay').classList.toggle('open');
};
window.closeSidebar = function() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('open');
};

// ══════════════════════════════════════════════
// LOGOUT
// ══════════════════════════════════════════════
window.logout = function() {
  if (!confirm('로그아웃 하시겠습니까?')) return;
  localStorage.removeItem('sf_sheet_id');
  if (S.accessToken && typeof google !== 'undefined') {
    google.accounts.oauth2.revoke(S.accessToken, ()=>{});
  }
  S = { tokenClient:S.tokenClient, gapiReady:S.gapiReady,
        accessToken:null, user:null, sheetId:null, driveRootId:null,
        teamName:null, inviteCode:null, inviteParam:null,
        db:{projects:[],tasks:[],milestones:[]}, originalDb:null, activeProjectId:null };
  history.replaceState({}, '', location.pathname);
  showScreen('screen-start');
};

// 폴더 ID 도움말
window.showFolderHelp = function() {
  alert('Google Drive 폴더 ID 찾는 방법:\n\n1. Google Drive(drive.google.com) 접속\n2. 원하는 폴더를 열기\n3. URL 주소창에서 마지막 부분 복사\n   예: .../folders/1sVzU5os15IYqUbGdt5RfUoh9GotdTimt\n   → 1sVzU5os15IYqUbGdt5RfUoh9GotdTimt 복사');
};

// ══════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════
parseInviteParam();
showScreen('screen-start');
initializeGapi();
window.addEventListener('load', () => setTimeout(initAuth, 300));
