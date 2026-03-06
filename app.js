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

window.onload = () => {
    showLoading(false);
    gapi.load('client', initGapiClient);

    appState.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
                appState.accessToken = tokenResponse.access_token;
                gapi.client.setToken({ access_token: appState.accessToken });

                fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                    headers: { 'Authorization': `Bearer ${appState.accessToken}` }
                })
                .then(res => res.json())
                .then(profile => {
                    document.getElementById('auth-container').style.display = 'none';
                    document.getElementById('app-layout').style.display = 'grid';

                    document.getElementById('user-avatar').src = profile.picture || 'https://ui-avatars.com/api/?name=User';
                    document.getElementById('user-name').innerText = profile.name;
                    document.getElementById('user-email').innerText = profile.email;

                    showToast(`${profile.name}님 환영합니다! 데이터 동기화 시작...`);
                    initSheetsDB(); 
                });
            }
        },
    });

    document.querySelector('.g_id_signin').addEventListener('click', () => {
        appState.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
};

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
        
        appState.db.projects = (vr[0].values || []).filter(r=>r[0]).map(row => ({ id: row[0], name: row[1], folderId: row[2] }));
        appState.db.tasks = (vr[1].values || []).filter(r=>r[0]).map(row => ({ id: row[0], projId: row[1], title: row[2], column: row[3], status: row[4] }));
        appState.db.milestones = (vr[2].values || []).filter(r=>r[0]).map(row => ({ id: row[0], projId: row[1], title: row[2], date: row[3], status: row[4] }));
        
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
                if(sheetName === 'Projects') range = `Projects!A${sheetRow}:C${sheetRow}`;
                if(sheetName === 'Tasks') range = `Tasks!A${sheetRow}:E${sheetRow}`;
                if(sheetName === 'Milestones') range = `Milestones!A${sheetRow}:E${sheetRow}`;
                
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
    
    if(ms.length === 0) {
        list.innerHTML = `<p style="color:var(--text-muted); font-size:0.9rem;">등록된 마일스톤 일정이 없습니다.</p>`;
        return;
    }

    ms.sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(m => {
        const dDay = Math.ceil((new Date(m.date) - new Date()) / (1000 * 60 * 60 * 24));
        const dDayText = dDay > 0 ? `D-${dDay}` : (dDay === 0 ? 'D-Day' : `D+${Math.abs(dDay)}`);
        
        list.innerHTML += `
            <div class="milestone-item">
                <div class="ms-info">
                    <strong>${m.title}</strong>
                    <span>🗓️ ${m.date} <span style="color:var(--primary); font-weight:600;">(${dDayText})</span></span>
                </div>
                <div class="ms-status">
                    <span class="badge ${STATUS_CLASSES[m.status]}" onclick="toggleConfirmStatus('milestone', '${m.id}')" title="클릭하여 결재 상태 변경">
                        ${m.status === STATUS.PENDING ? '🟡 ' : m.status === STATUS.APPROVED ? '🟢 ' : '🔴 '}${m.status}
                    </span>
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
                    <div class="card-footer">
                        <span class="badge ${STATUS_CLASSES[t.status]}" onclick="toggleConfirmStatus('task', '${t.id}')" title="상태 수정">
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
        document.getElementById('progress-bar').style.width = '0%';
        return;
    }
    const doneTasks = tasks.filter(t => t.column === 'DONE').length;
    const pct = Math.round((doneTasks / tasks.length) * 100);
    document.getElementById('progress-percent').innerText = `${pct}%`;
    document.getElementById('progress-bar').style.width = `${pct}%`;
}


/* --- User Interactions (Optimistic UI Implementations) --- */

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
            fields: "files(id, name, mimeType, webViewLink, iconLink)",
            orderBy: "modifiedTime desc"
        });
        let files = res.result.files;
        if (!files || files.length === 0) {
            container.innerHTML = '<span style="font-size:0.8rem;color:#888;">업로드된 산출물이 없습니다. 리포트 내보내기를 시도해보세요.</span>';
            return;
        }
        container.innerHTML = '';
        files.forEach(f => {
            container.innerHTML += `
            <div class="drive-file-card" onclick="window.open('${f.webViewLink}','_blank')">
                <img src="${f.iconLink || 'https://upload.wikimedia.org/wikipedia/commons/a/ae/Google_Sheets_2020_Logo.svg'}" class="file-icon" alt="icon">
                <div class="file-info"><p title="${f.name}">${f.name}</p></div>
            </div>
            `;
        });
    } catch(e) {
        console.error("Drive 페치 에러", e);
        container.innerHTML = '<span style="font-size:0.8rem;color:#ef4444;">파일 목록을 불러오지 못했습니다.</span>';
    }
}

async function exportReport() {
    const p = appState.db.projects.find(p => p.id === appState.activeProjectId);
    if (!p || p.folderId === '신규 생성 대기') {
        showToast("유효한 폴더 ID가 없습니다.");
        return;
    }

    if(confirm(`[${p.name}] 프로젝트의 진행 상황을 추출하여 Google Sheets 산출물로 발간하시겠습니까?\n저장 경로: 프로젝트 드라이브 폴더`)) {
        showLoading(true);
        try {
            let fileMetadata = {
                 name: `${p.name}_진척도리포트_${new Date().toISOString().split('T')[0]}`,
                 mimeType: 'application/vnd.google-apps.spreadsheet',
                 parents: [p.folderId]
            };
            let createRes = await gapi.client.drive.files.create({
                 resource: fileMetadata,
                 fields: 'id'
            });
            
            let newSheetId = createRes.result.id;
            
            let headerRow = ['태스크 ID', '제목', '상태(칸반)', '결재 상태'];
            let relatedTasks = appState.db.tasks.filter(t=>t.projId === p.id).map(t => [t.id, t.title, t.column, t.status]);
            let exportData = [headerRow, ...relatedTasks];
            
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: newSheetId,
                range: 'A1',
                valueInputOption: 'USER_ENTERED',
                resource: { values: exportData }
            });
            
            showToast(`리포트 파일 생성 성공! (${p.name})`);
            fetchDriveFiles(p.folderId);
        } catch(e) {
             showToast("리포트 생성 실패: " + e.message);
        } finally {
             showLoading(false);
        }
    }
}
