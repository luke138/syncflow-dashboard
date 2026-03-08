/**
 * 
 * [ 보안 경고 ]
 * 이 키는 클라이언트에 직접 노출됩니다.
 * 반드시 GCP(Google Cloud Platform) 콘솔의 "API 및 서비스 > 사용자 인증 정보" 메뉴에서 
 * API 키 제한사항을 애플리케이션 제한사항(HTTP 리퍼러)으로 설정하여, 
 * 허용된 도메인(예: https://luke138.github.io/*)에서만 호출되도록 보호해야 합니다.
 * 
 */

// --- Constants & Config ---
const GOOGLE_API_KEY = 'AIzaSyDNQ5eQEBLtluTNuetak1o6KT7LfGSzffc';
const GOOGLE_CLIENT_ID = '221461527280-lqj3ih8nbucjpb8bj2eulj5r3anknt0h.apps.googleusercontent.com';
const GOOGLE_SHEET_ID = '1EMfjllEnoYReXKSiYhzT2fTfaZAkxI7BKnt_ix2KEro';
const GOOGLE_DRIVE_ROOT_FOLDER_ID = '1sVzU5os15IYqUbGdt5RfUoh9GotdTimt';

const STATUS = {
    PENDING: '승인 대기',
    APPROVED: '승인 완료',
    REJECTED: '반려'
};

const STATUS_CLASSES = {
    '승인 대기': 'pending', '승인 완료': 'approved', '반려': 'rejected'
};

const DISCOVERY_DOCS = [
    "https://sheets.googleapis.com/$discovery/rest?version=v4",
    "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"
];
const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

// --- Global App State Management (Optimistic UI & Rollback) ---
let appState = {
    db: { projects: [], tasks: [], milestones: [] },
    originalDb: null, // Used for rollback
    activeProjectId: null,
    accessToken: null,
    isGapiReady: false,
    tokenClient: null
};

// --- Sync Queue State (Rate Limiting) ---
let syncQueue = [];
let syncTimeout = null;
const DEBOUNCE_DELAY_MS = 2500; // 2.5 seconds debounce

// --- Utility Functions ---

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.classList.add('show');
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

function showLoading(show) {
    const loader = document.getElementById('loading-overlay');
    loader.style.display = show ? 'flex' : 'none';
}

function generateUUID() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : uuid.v4(); // Fallback to uuid.js loaded in index.html
}

// Deep clone utility for state rollback
function cloneDeep(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// Ensure unique window namespace for inline HTML event handlers
window.toggleConfirmStatus = toggleConfirmStatus;
window.drag = drag;
window.allowDrop = allowDrop;
window.drop = drop;
window.generateUUID = generateUUID;
window.createNewProject = createNewProject;
window.exportReport = exportReport;
window.demoLogin = demoLogin;
window.logout = logout;
window.copyToKakao = copyToKakao;
window.googleLogin = googleLogin;
window.addTask = addTask;
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
window.initializeGapi = initializeGapi;

// --- Initialization & Setup ---

function initGapiClient() {
    gapi.client.init({
        apiKey: GOOGLE_API_KEY,
        discoveryDocs: DISCOVERY_DOCS,
    }).then(() => {
        appState.isGapiReady = true;
        console.log("GAPI Client Loaded");
    }).catch(error => {
        showToast("API 클라이언트 초기화 실패: " + JSON.stringify(error));
    });
}

// --- 공통 로그인 처리 ---
function handleAuthSuccess(accessToken) {
    appState.accessToken = accessToken;
    const trySetToken = () => {
        if (appState.isGapiReady) {
            gapi.client.setToken({ access_token: accessToken });
            fetchUserProfile(accessToken);
        } else {
            setTimeout(trySetToken, 200);
        }
    };
    trySetToken();
}

function fetchUserProfile(accessToken) {
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': 'Bearer ' + accessToken }
    })
    .then(res => res.json())
    .then(profile => {
        document.getElementById('auth-container').style.display = 'none';
        document.getElementById('app-layout').style.display = 'grid';
        document.getElementById('user-avatar').src = profile.picture || 'https://ui-avatars.com/api/?name=User&background=4f46e5&color=fff';
        document.getElementById('user-name').innerText = profile.name || '사용자';
        document.getElementById('user-email').innerText = profile.email || '';
        showToast((profile.name || '사용자') + '님 환영합니다! 데이터 동기화 중...');
        initSheetsDB();
    })
    .catch(err => {
        showToast('사용자 정보 로드 실패: ' + err.message);
    });
}

// GIS One-Tap 콜백
function handleGoogleOneTap(credentialResponse) {
    // One-Tap credential은 id_token → Sheets 권한 위해 OAuth 토큰 흐름으로 전환
    if (appState.tokenClient) {
        appState.tokenClient.requestAccessToken({ prompt: '' });
    } else {
        googleLogin();
    }
}

// 수동 Google 로그인 버튼
function googleLogin() {
    if (!appState.tokenClient) {
        showToast('Google 인증 초기화 중입니다. 잠시 후 다시 시도하세요.');
        setTimeout(googleLogin, 800);
        return;
    }
    appState.tokenClient.requestAccessToken({ prompt: 'select_account' });
}

function initializeAuth() {
    if (typeof google === 'undefined' || typeof google.accounts === 'undefined') {
        setTimeout(initializeAuth, 100);
        return;
    }

    // OAuth2 Token Client - Sheets + Drive 권한
    appState.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse.error) {
                showToast('Google 로그인 오류: ' + tokenResponse.error);
                return;
            }
            if (tokenResponse && tokenResponse.access_token) {
                handleAuthSuccess(tokenResponse.access_token);
            }
        },
        error_callback: (err) => {
            if (err && err.type !== 'popup_closed') {
                showToast('Google 인증 오류: ' + (err.message || err.type || '알 수 없음'));
            }
        }
    });

    // GIS One-Tap 렌더링
    try {
        google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGoogleOneTap,
            auto_select: false,
            cancel_on_tap_outside: true,
        });
        const btnContainer = document.getElementById('google-signin-btn');
        if (btnContainer) {
            google.accounts.id.renderButton(btnContainer, {
                type: 'standard',
                shape: 'rectangular',
                theme: 'outline',
                text: 'signin_with',
                size: 'large',
                locale: 'ko',
                width: 300,
            });
        }
    } catch(e) {
        console.warn('GIS One-Tap init failed:', e);
    }
}

function initializeGapi() {
    if (typeof gapi === 'undefined') {
        setTimeout(initializeGapi, 100);
        return;
    }
    gapi.load('client', initGapiClient);
}

showLoading(false);
initializeAuth();
initializeGapi();

function logout() {
    if (confirm("로그아웃 하시겠습니까?")) {
        if (appState.accessToken) {
            google.accounts.oauth2.revoke(appState.accessToken, () => {
                console.log('Token revoked.');
            });
            appState.accessToken = null;
        }
        document.getElementById('auth-container').style.display = 'flex';
        document.getElementById('app-layout').style.display = 'none';
    }
}

function demoLogin() {
    document.getElementById('auth-container').style.display = 'none';
    document.getElementById('app-layout').style.display = 'grid';
    document.getElementById('user-avatar').src = 'https://ui-avatars.com/api/?name=CEO&background=4f46e5&color=fff&size=128';
    document.getElementById('user-name').innerText = '김대표 (CEO)';
    document.getElementById('user-email').innerText = 'ceo@syncflow.io';
    renderAll();
    showToast("SyncFlow 계정 인증에 성공했습니다. (로컬 데모 모드)");
}


// --- Google Sheets Operations (Cold Start & Granular Updates) ---

async function initSheetsDB() {
    showLoading(true);
    try {
        let response = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
        let sheetTitles = response.result.sheets.map(s => s.properties.title);
        let neededSheets = ['Projects', 'Tasks', 'Milestones'];

        let requiresSeeding = false;

        for (let title of neededSheets) {
            if (!sheetTitles.includes(title)) {
                await gapi.client.sheets.spreadsheets.batchUpdate({
                    spreadsheetId: GOOGLE_SHEET_ID,
                    resource: { requests: [{ addSheet: { properties: { title: title } } }] }
                });
                requiresSeeding = true;
            }
        }

        // Fetch current data ranges to detect empty sheets (Cold Start Handle)
        let getRes = await gapi.client.sheets.spreadsheets.values.batchGet({
            spreadsheetId: GOOGLE_SHEET_ID,
            ranges: ['Projects!A:Z', 'Tasks!A:Z', 'Milestones!A:Z']
        });

        const vr = getRes.result.valueRanges;
        const projectsEmpty = !vr[0].values || vr[0].values.length === 0;
        const tasksEmpty = !vr[1].values || vr[1].values.length === 0;
        const msEmpty = !vr[2].values || vr[2].values.length === 0;

        if (projectsEmpty || tasksEmpty || msEmpty || requiresSeeding) {
            console.warn("Empty database detected. Initializing schema and dummy data (Cold Start)...");
            await seedInitialData();
        }

        await loadAllDataFromSheets();

    } catch (err) {
        showToast("초기 DB 로드 실패: " + err.message);
        console.error(err);
    } finally {
        showLoading(false);
    }
}

async function seedInitialData() {
    const sampleProjectId = generateUUID();

    const initialData = [
        {
            range: 'Projects!A1',
            values: [
                ['ID', 'Name', 'FolderID'], // Headers
                [sampleProjectId, '샘플 프로젝트', '신규 생성 대기']
            ]
        },
        {
            range: 'Tasks!A1',
            values: [
                ['ID', 'ProjectID', 'Title', 'Column', 'Status'], // Headers
                [generateUUID(), sampleProjectId, '경쟁사 분석 리포트', 'TODO', STATUS.PENDING],
                [generateUUID(), sampleProjectId, 'UI/UX 시안 디자인', 'DOING', STATUS.APPROVED],
                [generateUUID(), sampleProjectId, '서버 아키텍처 설계', 'DONE', STATUS.APPROVED]
            ]
        },
        {
            range: 'Milestones!A1',
            values: [
                ['ID', 'ProjectID', 'Title', 'Date', 'Status'], // Headers
                [generateUUID(), sampleProjectId, '클로즈 베타 오픈', new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], STATUS.PENDING]
            ]
        }
    ];

    await gapi.client.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        resource: {
            valueInputOption: 'USER_ENTERED',
            data: initialData
        }
    });
}

async function loadAllDataFromSheets() {
    showLoading(true);
    try {
        let response = await gapi.client.sheets.spreadsheets.values.batchGet({
            spreadsheetId: GOOGLE_SHEET_ID,
            ranges: ['Projects!A2:C', 'Tasks!A2:E', 'Milestones!A2:E']
        });

        let vr = response.result.valueRanges;

        appState.db.projects = (vr[0].values || []).filter(r => r[0]).map(row => ({ id: row[0], name: row[1], folderId: row[2] }));
        appState.db.tasks = (vr[1].values || []).filter(r => r[0]).map(row => ({ id: row[0], projId: row[1], title: row[2], column: row[3], status: row[4] }));
        appState.db.milestones = (vr[2].values || []).filter(r => r[0]).map(row => ({ id: row[0], projId: row[1], title: row[2], date: row[3], status: row[4] }));

        if (appState.db.projects.length > 0 && !appState.activeProjectId) {
            appState.activeProjectId = appState.db.projects[0].id;
        }

        // Save a clean clone for rollback
        appState.originalDb = cloneDeep(appState.db);

        renderAll();
        // showToast("데이터 동기화 완료 🟢");

    } catch (err) {
        showToast("데이터 로드 오류: " + err.message);
        console.error(err);
    } finally {
        showLoading(false);
    }
}


// --- Queue & Debounce Architecture (Rate Limiting Fix) ---

// Push granular requests (row updates or appends) into a queue
function queueSyncAction(actionConfig) {
    syncQueue.push(actionConfig);
    console.log(`[Queue] Action added. Queue size: ${syncQueue.length}`);

    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }

    // UI reflects optimistic change immediately, display saving indicator
    document.getElementById('loading-overlay').querySelector('p').innerText = "변경 사항 백그라운드 동기화 중...";
    showLoading(true);

    syncTimeout = setTimeout(processSyncQueue, DEBOUNCE_DELAY_MS);
}

// Empties the queue and executes batch granular updates against Google Sheets API
async function processSyncQueue() {
    if (syncQueue.length === 0) {
        showLoading(false);
        return;
    }

    const currentBatch = [...syncQueue];
    syncQueue = []; // Clear current queue eagerly

    console.log(`[Sync] Processing batch of size ${currentBatch.length}...`);

    try {
        // Fetch current snapshot to find strict row numbers for granular updates
        const fetchRes = await gapi.client.sheets.spreadsheets.values.batchGet({
            spreadsheetId: GOOGLE_SHEET_ID,
            ranges: ['Projects!A:A', 'Tasks!A:A', 'Milestones!A:A'] // Fetch only IDs to find rows
        });
        const currentIds = {
            'Projects': (fetchRes.result.valueRanges[0].values || []).map(row => row[0]),
            'Tasks': (fetchRes.result.valueRanges[1].values || []).map(row => row[0]),
            'Milestones': (fetchRes.result.valueRanges[2].values || []).map(row => row[0])
        };

        let updateData = [];
        let appendConfigs = { 'Projects': [], 'Tasks': [], 'Milestones': [] };

        currentBatch.forEach(action => {
            const { sheetName, data, isNew } = action;
            const rowIndex = currentIds[sheetName].indexOf(data[0]);

            if (isNew || rowIndex === -1) {
                // Determine Append operation
                appendConfigs[sheetName].push(data);
            } else {
                // Determine granular Update operation (rowIndex is 0-indexed, Sheets rows are 1-indexed)
                // However, column A has header, so rowIndex 1 in array equals row 2 in sheet.
                const sheetRow = rowIndex + 1;
                let range = '';
                if (sheetName === 'Projects') range = `Projects!A${sheetRow}:C${sheetRow}`;
                if (sheetName === 'Tasks') range = `Tasks!A${sheetRow}:E${sheetRow}`;
                if (sheetName === 'Milestones') range = `Milestones!A${sheetRow}:E${sheetRow}`;

                updateData.push({
                    range: range,
                    values: [data]
                });
            }
        });

        // 1. Process Updates
        if (updateData.length > 0) {
            await gapi.client.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: GOOGLE_SHEET_ID,
                resource: {
                    valueInputOption: "USER_ENTERED",
                    data: updateData
                }
            });
        }

        // 2. Process Appends sequentially per sheet (batchAppend is not natively available like batchUpdate)
        for (const sheetName of Object.keys(appendConfigs)) {
            if (appendConfigs[sheetName].length > 0) {
                await gapi.client.sheets.spreadsheets.values.append({
                    spreadsheetId: GOOGLE_SHEET_ID,
                    range: `${sheetName}!A1`,
                    valueInputOption: "USER_ENTERED",
                    insertDataOption: "INSERT_ROWS",
                    resource: { values: appendConfigs[sheetName] }
                });
            }
        }

        console.log(`[Sync] Batch successful.`);
        showToast("모든 변경 사항이 저장되었습니다. 🟢");

        // Sync complete, set new original state for future rollbacks
        appState.originalDb = cloneDeep(appState.db);

    } catch (err) {
        console.error("Batch Sync Failed", err);
        showToast(`🚨 동기화 실패. 이전 상태로 롤백합니다: ${err.message}`);

        // Rollback state and re-render
        appState.db = cloneDeep(appState.originalDb);
        renderAll();
    } finally {
        // Reset loader text
        document.getElementById('loading-overlay').querySelector('p').innerText = "데이터를 동기화 중입니다...";
        showLoading(false);
    }
}


/* --- Rendering Engine --- */

function renderAll() {
    renderPendingApprovals();
    renderSidebar();
    renderMain();
}

function renderPendingApprovals() {
    const marquee = document.getElementById('pending-marquee');
    marquee.innerHTML = '';

    const pendingTasks = appState.db.tasks.filter(t => t.status === STATUS.PENDING);
    const pendingMs = appState.db.milestones.filter(m => m.status === STATUS.PENDING);

    const allPending = [...pendingTasks, ...pendingMs];

    if (allPending.length === 0) {
        marquee.innerHTML = `<span style="opacity: 0.7;">의사결정 보류 안건이 없습니다. 🎉</span>`;
        return;
    }

    allPending.forEach(item => {
        const el = document.createElement('div');
        el.className = 'pending-item';
        el.innerHTML = `
            <span class="badge pending">🟡 1차 리뷰 요망</span>
            <span>${item.title}</span>
            <button onclick="copyToKakao('${item.projId}', '${item.title}', '${item.status}')" title="카카오톡 공유용 복사" style="margin-left: 4px; background: none; border: none; cursor: pointer; font-size: 1.1rem; padding: 0 4px; transition: transform 0.2s;">
                💬
            </button>
        `;
        marquee.appendChild(el);
    });
}

function renderSidebar() {
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    document.getElementById('project-count').innerText = appState.db.projects.length;

    appState.db.projects.forEach(p => {
        const div = document.createElement('div');
        div.className = `project-item ${p.id === appState.activeProjectId ? 'active' : ''}`;
        div.innerHTML = `📁 ${p.name}`;
        div.onclick = () => {
            appState.activeProjectId = p.id;
            renderSidebar();
            renderMain();
        };
        list.appendChild(div);
    });
}

function renderMain() {
    const project = appState.db.projects.find(p => p.id === appState.activeProjectId);
    if (!project) {
        document.getElementById('current-project-title').innerText = "프로젝트를 선택하세요.";
        document.getElementById('current-folder-id').innerText = "-";
        return;
    }
    document.getElementById('current-project-title').innerText = project.name;
    document.getElementById('current-folder-id').innerText = project.folderId || '최초 생성 시 할당됨';

    renderMilestones(project.id);
    renderKanban(project.id);
    renderProgress(project.id);
    fetchDriveFiles(project.folderId);
}

function renderMilestones(projId) {
    const list = document.getElementById('milestone-list');
    list.innerHTML = '';
    const ms = appState.db.milestones.filter(m => m.projId === projId);

    if (ms.length === 0) {
        list.innerHTML = `<p style="color:var(--text-muted); font-size:0.9rem;">등록된 마일스톤 일정이 없습니다.</p>`;
        return;
    }

    ms.sort((a, b) => new Date(a.date) - new Date(b.date)).forEach(m => {
        const dDay = Math.ceil((new Date(m.date) - new Date()) / (1000 * 60 * 60 * 24));
        const dDayText = dDay > 0 ? `D-${dDay}` : (dDay === 0 ? 'D-Day' : `D+${Math.abs(dDay)}`);

        list.innerHTML += `
            <div class="ms-node">
                <div class="ms-circle ${m.status === STATUS.APPROVED ? 'done' : m.status === STATUS.PENDING ? 'active' : ''}" 
                     onclick="toggleConfirmStatus('milestone', '${m.id}')" title="클릭하여 결재 상태 변경: ${m.status}"></div>
                <div class="ms-node-info">
                    <strong>${m.title}</strong>
                    <span>${dDayText}</span>
                </div>
            </div>
        `;
    });
}

function renderKanban(projId) {
    const cols = ['TODO', 'DOING', 'DONE'];
    cols.forEach(col => {
        const container = document.getElementById(`col-${col}`);
        container.innerHTML = '';

        const tasks = appState.db.tasks.filter(t => t.projId === projId && t.column === col);
        document.getElementById(`count-${col}`).innerText = tasks.length;

        tasks.forEach(t => {
            // NOTE: ID is passed as string stringified
            container.innerHTML += `
                <div class="kanban-card" draggable="true" ondragstart="drag(event, '${t.id}')">
                    <h4>${t.title}</h4>
                    <div class="card-meta">
                        <div class="meta-text">
                            <span>마감일: 지정안됨</span>
                            <span>담당자: 미정</span>
                        </div>
                        <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(t.title.charAt(0))}&background=random" class="card-avatar" alt="A">
                    </div>
                    <div class="card-footer">
                        <a href="https://drive.google.com" target="_blank" class="card-link">
                            <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" alt="Drive">
                            관련 파일 보기
                        </a>
                        <span class="badge ${STATUS_CLASSES[t.status]}" onclick="toggleConfirmStatus('task', '${t.id}')" title="상태 수정" style="margin-left:auto;">
                            ${t.status === STATUS.PENDING ? '🟡 ' : t.status === STATUS.APPROVED ? '🟢 ' : '🔴 '}${t.status}
                        </span>
                    </div>
                </div>
            `;
        });
    });
}

function renderProgress(projId) {
    const tasks = appState.db.tasks.filter(t => t.projId === projId);
    if (tasks.length === 0) {
        document.getElementById('progress-percent').innerText = '0%';
        document.getElementById('progress-circle').setAttribute('stroke-dasharray', '0, 100');
        return;
    }
    const doneTasks = tasks.filter(t => t.column === 'DONE').length;
    const pct = Math.round((doneTasks / tasks.length) * 100);
    document.getElementById('progress-percent').innerText = `${pct}%`;
    document.getElementById('progress-circle').setAttribute('stroke-dasharray', `${pct}, 100`);
}


/* --- User Interactions (Optimistic UI Implementations) --- */

function copyToKakao(projId, taskTitle, status) {
    const proj = appState.db.projects.find(p => p.id === projId);
    const projName = proj ? proj.name : 'Unknown Project';

    const text = `🚨 [CEO 결재 요청] 🚨\n\n🏢 프로젝트: ${projName}\n✅ 요청 안건: ${taskTitle}\n📊 현재 상태: ${status}\n\n💬 대표님, 위 안건에 대한 결재를 부탁드립니다. 아래 링크를 통해 대시보드에서 즉시 승인하실 수 있습니다.\n\n🔗 대시보드 바로가기:\n${window.location.href}`;

    navigator.clipboard.writeText(text).then(() => {
        showToast("✅ 복사되었습니다! 카카오톡에 붙여넣기 하세요");
    }).catch(err => {
        showToast("❌ 클립보드 복사에 실패했습니다.");
        console.error(err);
    });
}

function toggleConfirmStatus(type, id) {
    const item = type === 'task' ? appState.db.tasks.find(t => t.id === id) : appState.db.milestones.find(m => m.id === id);
    if (!item) return;

    if (item.status === STATUS.PENDING) item.status = STATUS.APPROVED;
    else if (item.status === STATUS.APPROVED) item.status = STATUS.REJECTED;
    else item.status = STATUS.PENDING;

    // Optimistic Render
    renderAll();

    // Add to Queue for debounced background sync
    const sheetName = type === 'task' ? 'Tasks' : 'Milestones';
    const rowData = type === 'task'
        ? [item.id, item.projId, item.title, item.column, item.status]
        : [item.id, item.projId, item.title, item.date, item.status];

    queueSyncAction({ sheetName, data: rowData, isNew: false });
}

function drag(ev, id) {
    ev.dataTransfer.setData("taskId", id);
}

function allowDrop(ev) {
    ev.preventDefault();
}

function drop(ev, expectedCol) {
    ev.preventDefault();
    const taskId = ev.dataTransfer.getData("taskId");
    const task = appState.db.tasks.find(t => t.id === taskId);

    if (task && task.column !== expectedCol) {
        task.column = expectedCol;

        // Optimistic Render
        renderMain();

        // Add to update queue
        queueSyncAction({
            sheetName: 'Tasks',
            data: [task.id, task.projId, task.title, task.column, task.status],
            isNew: false
        });
    }
}

async function createNewProject() {
    const name = prompt("새 프로젝트 폴더 이름을 영어/숫자로 지어주세요 (빈칸 없이):");
    if (!name || name.trim() === '') return;

    showLoading(true);
    try {
        let fileMetadata = {
            'name': name.trim(),
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [GOOGLE_DRIVE_ROOT_FOLDER_ID]
        };

        let response = await gapi.client.drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });

        const newFolderId = response.result.id;
        const newProjId = generateUUID();

        const projData = [newProjId, name.trim(), newFolderId];
        const taskData = [generateUUID(), newProjId, '첫 태스크를 생성하세요', 'TODO', STATUS.PENDING];
        const msData = [generateUUID(), newProjId, '목표 일정 설정', new Date().toISOString().split('T')[0], STATUS.PENDING];

        // Optimistic State Update
        appState.db.projects.push({ id: newProjId, name: name.trim(), folderId: newFolderId });
        appState.db.tasks.push({ id: taskData[0], projId: newProjId, title: taskData[2], column: taskData[3], status: taskData[4] });
        appState.db.milestones.push({ id: msData[0], projId: newProjId, title: msData[2], date: msData[3], status: msData[4] });

        appState.activeProjectId = newProjId;
        renderAll();

        // Queue new items
        queueSyncAction({ sheetName: 'Projects', data: projData, isNew: true });
        queueSyncAction({ sheetName: 'Tasks', data: taskData, isNew: true });
        queueSyncAction({ sheetName: 'Milestones', data: msData, isNew: true });

    } catch (err) {
        showToast(`디렉토리 생성 실패: ${err.message}`);
        console.error(err);
    } finally {
        showLoading(false); // Wait for the queue to show sync loader if successful.
    }
}

async function fetchDriveFiles(folderId) {
    const container = document.getElementById('drive-files');
    container.innerHTML = '<span style="font-size:0.8rem;color:#888;">로딩 중...</span>';
    if (!folderId || folderId === '최초 생성 시 할당됨' || folderId === '신규 생성 대기') {
        container.innerHTML = '';
        return;
    }
    try {
        let res = await gapi.client.drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "files(id, name, mimeType, webViewLink, iconLink, modifiedTime)",
            orderBy: "modifiedTime desc"
        });
        let files = res.result.files;
        if (!files || files.length === 0) {
            container.innerHTML = '<span style="font-size:0.8rem;color:#888;">업로드된 산출물이 없습니다. 리포트 내보내기를 시도해보세요.</span>';
            return;
        }
        container.innerHTML = '';
        files.forEach(f => {
            let bgClass = 'bg-other';
            let iconText = '📄';
            if (f.mimeType.includes('spreadsheet')) { bgClass = 'bg-sheets'; iconText = '📊'; }
            else if (f.mimeType.includes('document')) { bgClass = 'bg-docs'; iconText = '📝'; }
            else if (f.mimeType.includes('presentation')) { bgClass = 'bg-slides'; iconText = '💡'; }

            const modDate = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '최근 수정';

            container.innerHTML += `
            <div class="drive-file-card" onclick="window.open('${f.webViewLink}','_blank')">
                <div class="file-icon ${bgClass}" style="font-size: 1.5rem;">${iconText}</div>
                <div class="file-info">
                    <p title="${f.name}">${f.name}</p>
                    <span>마지막 수정: ${modDate}</span>
                </div>
            </div>
            `;
        });
    } catch (e) {
        console.error("Drive 페치 에러", e);
        container.innerHTML = '<span style="font-size:0.8rem;color:#ef4444;">파일 목록을 불러오지 못했습니다.</span>';
    }
}

async function exportReport() {
    const p = appState.db.projects.find(proj => proj.id === appState.activeProjectId);
    if (!p) {
        showToast('먼저 프로젝트를 선택하세요.');
        return;
    }
    const isDemoMode = !appState.accessToken;
    if (isDemoMode) {
        showToast('Google 로그인 후 Drive 저장이 가능합니다.');
        return;
    }
    if (p.folderId === '신규 생성 대기' || p.folderId === '최초 생성 시 할당됨') {
        showToast('유효한 Drive 폴더 ID가 없습니다.');
        return;
    }

    if (!confirm(`[${p.name}] 리포트를 Google Drive에 저장하시겠습니까?`)) return;

    showLoading(true);
    try {
        const today = new Date().toISOString().split('T')[0];
        const tasks = appState.db.tasks.filter(t => t.projId === p.id);
        const milestones = appState.db.milestones.filter(m => m.projId === p.id);
        const doneCnt = tasks.filter(t => t.column === 'DONE').length;
        const pct = tasks.length > 0 ? Math.round((doneCnt / tasks.length) * 100) : 0;

        // 1. Spreadsheet 파일 생성
        let createRes = await gapi.client.drive.files.create({
            resource: {
                name: `[리포트] ${p.name}_${today}`,
                mimeType: 'application/vnd.google-apps.spreadsheet',
                parents: [p.folderId]
            },
            fields: 'id,webViewLink'
        });
        const newSheetId = createRes.result.id;
        const sheetUrl = createRes.result.webViewLink;

        // 2. 데이터 작성 (요약 + 태스크 + 마일스톤 시트)
        const summaryData = [
            ['📊 SyncFlow 프로젝트 리포트', '', '', ''],
            ['프로젝트명', p.name, '', ''],
            ['생성일', today, '', ''],
            ['Drive 폴더 ID', p.folderId, '', ''],
            ['', '', '', ''],
            ['📈 진척 요약', '', '', ''],
            ['전체 태스크', tasks.length, '', ''],
            ['완료 태스크', doneCnt, '', ''],
            ['진척률', pct + '%', '', ''],
            ['', '', '', ''],
            ['📋 태스크 목록', '', '', ''],
            ['번호', '태스크명', '칸반 상태', 'CEO 결재'],
            ...tasks.map((t, i) => [i + 1, t.title, t.column, t.status]),
            ['', '', '', ''],
            ['🏁 마일스톤', '', '', ''],
            ['번호', '마일스톤', '목표일', '결재 상태'],
            ...milestones.map((m, i) => [i + 1, m.title, m.date, m.status]),
        ];

        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: newSheetId,
            range: 'Sheet1!A1',
            valueInputOption: 'USER_ENTERED',
            resource: { values: summaryData }
        });

        // 3. 서식 적용 (헤더 볼드, 배경색)
        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: newSheetId,
            resource: {
                requests: [
                    // 타이틀 행 (A1) - 굵게 + 배경
                    {
                        repeatCell: {
                            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.29, green: 0.42, blue: 0.98 },
                                    textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    // 섹션 헤더들 강조
                    {
                        repeatCell: {
                            range: { sheetId: 0, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 4 },
                            cell: { userEnteredFormat: { backgroundColor: { red: 0.93, green: 0.95, blue: 1 }, textFormat: { bold: true } } },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        repeatCell: {
                            range: { sheetId: 0, startRowIndex: 10, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 4 },
                            cell: { userEnteredFormat: { backgroundColor: { red: 0.93, green: 0.95, blue: 1 }, textFormat: { bold: true } } },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    // 열 너비 자동 조정
                    {
                        autoResizeDimensions: {
                            dimensions: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 4 }
                        }
                    }
                ]
            }
        });

        showToast('✅ 리포트 저장 완료! Drive에서 확인하세요.');
        fetchDriveFiles(p.folderId);

    } catch (e) {
        showToast('리포트 생성 실패: ' + e.message);
        console.error(e);
    } finally {
        showLoading(false);
    }
}


/* =============================================
   [FIX] 모바일 사이드바 토글
   ============================================= */
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
}

/* =============================================
   [FIX] 태스크 추가
   ============================================= */
function addTask() {
    if (!appState.activeProjectId) {
        showToast('먼저 프로젝트를 선택하세요.');
        return;
    }
    const title = prompt('새 태스크 제목을 입력하세요:');
    if (!title || title.trim() === '') return;

    const newTaskId = generateUUID();
    const taskData = [newTaskId, appState.activeProjectId, title.trim(), 'TODO', STATUS.PENDING];

    // Optimistic Update
    appState.db.tasks.push({ id: newTaskId, projId: appState.activeProjectId, title: title.trim(), column: 'TODO', status: STATUS.PENDING });
    renderAll();

    queueSyncAction({ sheetName: 'Tasks', data: taskData, isNew: true });
    showToast('태스크가 추가되었습니다.');
}
