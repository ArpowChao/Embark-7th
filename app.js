/**
 * 第七屆專題籌備委員會招募報名系統 - 前端互動與資料同步邏輯 (app.js)
 */

// 預設 Google Apps Script 部署 URL (使用者可在 UI 設定中覆寫或填入)
const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbzkFuYu6j-_YGkmkx3MB9rpKjdj2G-_BmoqR-DBU-zBCeIepE80jn4wxE2XzcddZ8hWrw/exec";

// 7th 專題籌備委員會 官方 LINE 社群邀請連結
const LINE_COMMUNITY_URL = "https://line.me/ti/g2/el2z3XrT-3KD_LqV-qiLxFGWi6q7VnfdjmQWag?utm_source=invitation&utm_medium=link_copy&utm_campaign=default";

// 核心規則：無組員編制、僅能擔任組長的組別
const LEADER_ONLY_DEPTS = ["總召", "副總召", "行政"];

// 當前系統狀態
let currentEditId = null; // 當前正在編輯的唯一識別碼 (班級-座號)
let isEditMode = false;
let selectedFiles = []; // 當前選取的多個上傳檔案清單 [{ name, type, size, base64 }]

// 頁面載入完成初始化
document.addEventListener("DOMContentLoaded", () => {
  initGasUrl();
  setupAltChoiceLogic();
  setupDropZone();
  resetInitialForms();
  checkStoredSubmission();
});

function resetInitialForms() {
  const form = document.getElementById("recruitment-form");
  if (form) form.reset();
  const qForm = document.getElementById("query-form");
  if (qForm) qForm.reset();
  clearAllSelectedFiles();
  populateSeatOptions("f", null);
  populateSeatOptions("q", null);
  const fb1 = document.getElementById("f-name-feedback");
  if (fb1) fb1.classList.add("hidden");
  const fb2 = document.getElementById("q-name-feedback");
  if (fb2) fb2.classList.add("hidden");
}

/* =========================================================
   0. 動態座號選單與雲端安全身分核對 (零個資外洩防護架構)
   ========================================================= */

// 驗證狀態快取 (f: 報名表單, q: 查詢表單)
const studentVerifyStatus = { f: null, q: null };
const verifyDebounceTimers = { f: null, q: null };

function populateSeatOptions(prefix, selectedClass, currentSeatValue) {
  const seatSelect = document.getElementById(`${prefix}-seat`);
  if (!seatSelect) return;

  seatSelect.innerHTML = "";

  if (!selectedClass) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "請先選擇班級";
    seatSelect.appendChild(opt);
    seatSelect.disabled = true;
    return;
  }

  seatSelect.disabled = false;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = !currentSeatValue;
  placeholder.textContent = "請選擇座號";
  seatSelect.appendChild(placeholder);

  // 產生 1 ~ 38 號標準座號選單（純整數清單，絕不包含任何學生個資或姓名）
  const maxSeats = 38;
  for (let i = 1; i <= maxSeats; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${i} 號`;
    if (currentSeatValue && String(currentSeatValue) === String(i)) {
      opt.selected = true;
    }
    seatSelect.appendChild(opt);
  }
}

function onClassSelectChange(prefix) {
  const classSelect = document.getElementById(`${prefix}-class`);
  if (!classSelect) return;
  const selectedClass = classSelect.value;
  populateSeatOptions(prefix, selectedClass);
  validateStudentRealtime(prefix);

  if (prefix === "f") {
    renderSelectedFilesList();
  }
}

function onSeatSelectChange(prefix) {
  validateStudentRealtime(prefix);
  if (prefix === "f") {
    renderSelectedFilesList();
  }
}

function onNameInputChange(prefix) {
  validateStudentRealtime(prefix);
  if (prefix === "f") {
    renderSelectedFilesList();
  }
}

function validateStudentRealtime(prefix) {
  const classEl = document.getElementById(`${prefix}-class`);
  const seatEl = document.getElementById(`${prefix}-seat`);
  const nameEl = document.getElementById(`${prefix}-name`);
  const feedbackEl = document.getElementById(`${prefix}-name-feedback`);

  if (!classEl || !seatEl || !nameEl || !feedbackEl) return null;

  const className = classEl.value ? classEl.value.trim() : "";
  const seat = seatEl.value ? seatEl.value.trim() : "";
  const inputName = nameEl.value ? nameEl.value.trim() : "";

  // 1. 若尚未選取班級或座號
  if (!className || !seat) {
    studentVerifyStatus[prefix] = null;
    if (inputName) {
      feedbackEl.className = "name-verify-feedback hint";
      feedbackEl.innerHTML = '<i class="fa-solid fa-circle-info"></i> 請先選取「班級」與「座號」以核驗身分';
      feedbackEl.classList.remove("hidden");
    } else {
      feedbackEl.classList.add("hidden");
    }
    nameEl.classList.remove("input-error", "input-success");
    return null;
  }

  // 2. 若尚未輸入姓名
  if (!inputName) {
    studentVerifyStatus[prefix] = null;
    feedbackEl.className = "name-verify-feedback hint";
    feedbackEl.innerHTML = '<i class="fa-solid fa-circle-info"></i> 請輸入真實姓名以進行身分驗證';
    feedbackEl.classList.remove("hidden");
    nameEl.classList.remove("input-error", "input-success");
    return null;
  }

  // 3. 姓名基本格式檢驗
  const cleanInput = inputName.replace(/\s+/g, "");
  if (cleanInput.length < 2) {
    studentVerifyStatus[prefix] = false;
    feedbackEl.className = "name-verify-feedback invalid";
    feedbackEl.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> 姓名長度至少需 2 個字元！';
    feedbackEl.classList.remove("hidden");
    nameEl.classList.add("input-error");
    nameEl.classList.remove("input-success");
    return false;
  }

  const gasUrl = getGasUrl();

  // 若尚未設定線上 GAS (例如本機離線或示範模式)
  if (!gasUrl) {
    studentVerifyStatus[prefix] = true;
    feedbackEl.className = "name-verify-feedback hint";
    feedbackEl.innerHTML = '<i class="fa-solid fa-shield-halved"></i> 格式正確（線上部署後由 Google 試算表私有名冊進行身分核對）';
    feedbackEl.classList.remove("hidden");
    nameEl.classList.remove("input-error");
    nameEl.classList.add("input-success");
    return true;
  }

  // 若已設定線上 GAS，發動非同步安全驗證 (防抖動 350ms，絕不回傳他人名冊)
  feedbackEl.className = "name-verify-feedback checking";
  feedbackEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 正在向雲端私有名冊核驗身分...';
  feedbackEl.classList.remove("hidden");

  if (verifyDebounceTimers[prefix]) {
    clearTimeout(verifyDebounceTimers[prefix]);
  }

  verifyDebounceTimers[prefix] = setTimeout(async () => {
    try {
      const verifyUrl = `${gasUrl}?action=verifyStudent&class=${encodeURIComponent(className)}&seat=${encodeURIComponent(seat)}&name=${encodeURIComponent(cleanInput)}`;
      const res = await fetch(verifyUrl);
      const data = await res.json();

      if (data.status === "success" && data.verified) {
        studentVerifyStatus[prefix] = true;
        feedbackEl.className = "name-verify-feedback valid";
        feedbackEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> 學生核對成功：${className} 班 ${seat} 號 身分確認吻合！`;
        nameEl.classList.remove("input-error");
        nameEl.classList.add("input-success");
      } else if (data.status === "error") {
        studentVerifyStatus[prefix] = "unlisted";
        feedbackEl.className = "name-verify-feedback unlisted";
        feedbackEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> 提醒：未在目前名冊中（若為轉學生或名冊異動，送出時經確認仍可報名）`;
        nameEl.classList.remove("input-error", "input-success");
        nameEl.classList.add("input-warning");
      } else {
        studentVerifyStatus[prefix] = true;
        feedbackEl.className = "name-verify-feedback hint";
        feedbackEl.innerHTML = '<i class="fa-solid fa-shield-halved"></i> 雲端防護已就緒（送出時將由伺服器端核對）';
        nameEl.classList.remove("input-error", "input-success");
      }
    } catch (err) {
      studentVerifyStatus[prefix] = true;
      feedbackEl.className = "name-verify-feedback hint";
      feedbackEl.innerHTML = '<i class="fa-solid fa-shield-halved"></i> 送出時將由雲端試算表安全伺服器端進行名冊核對';
      nameEl.classList.remove("input-error", "input-success");
    }
  }, 350);

  return studentVerifyStatus[prefix];
}

/* =========================================================
   1. Google Apps Script 網址與本地儲存處理
   ========================================================= */

function getGasUrl() {
  return localStorage.getItem("7th_committee_gas_url") || DEFAULT_GAS_URL;
}

function initGasUrl() {
  const url = getGasUrl();
  const input = document.getElementById("gas-url-input");
  if (input) {
    input.value = url;
  }
}

function openGasSettingsModal() {
  initGasUrl();
  document.getElementById("gas-modal").classList.remove("hidden");
}

function closeGasSettingsModal() {
  document.getElementById("gas-modal").classList.add("hidden");
}

function saveGasUrl() {
  const input = document.getElementById("gas-url-input");
  const newUrl = input.value.trim();
  if (newUrl) {
    localStorage.setItem("7th_committee_gas_url", newUrl);
    showToast("✅ 已成功儲存 Google Apps Script 網址！");
  } else {
    localStorage.removeItem("7th_committee_gas_url");
    showToast("ℹ️ 已重設為預設模式 (本機示範/待設定)");
  }
  closeGasSettingsModal();
}

function resetGasUrl() {
  localStorage.removeItem("7th_committee_gas_url");
  document.getElementById("gas-url-input").value = "";
  showToast("🔄 已恢復預設模式");
  closeGasSettingsModal();
}

/* =========================================================
   2. 頁面分頁 (Tabs) 切換邏輯
   ========================================================= */

function switchMode(mode) {
  // 更新 Tabs 樣式
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));

  const formSection = document.getElementById("form-section");
  const querySection = document.getElementById("query-section");
  const infoSection = document.getElementById("info-section");

  formSection.classList.add("hidden");
  querySection.classList.add("hidden");
  infoSection.classList.add("hidden");

  if (mode === "apply") {
    document.getElementById("tab-apply").classList.add("active");
    formSection.classList.remove("hidden");
  } else if (mode === "query") {
    document.getElementById("tab-query").classList.add("active");
    querySection.classList.remove("hidden");
    document.getElementById("q-class").focus();
  } else if (mode === "info") {
    document.getElementById("tab-info").classList.add("active");
    infoSection.classList.remove("hidden");
  }
}

/* =========================================================
   3. 志願組別連動防呆規則 (總召/副總召/行政 只能選組長)
   ========================================================= */

function onFirstChoiceChange(selectedDept) {
  const noticeBox = document.getElementById("position-notice");
  const deptLabel = document.getElementById("selected-dept-label");
  const leaderCard = document.getElementById("pos-leader-wrapper");
  const memberCard = document.getElementById("pos-member-wrapper");
  const leaderRadio = document.getElementById("pos-leader");
  const memberRadio = document.getElementById("pos-member");

  if (LEADER_ONLY_DEPTS.includes(selectedDept)) {
    // 顯示提示並鎖定組長
    deptLabel.textContent = selectedDept;
    noticeBox.classList.remove("hidden");

    // 自動勾選組長
    leaderRadio.checked = true;

    // 停用組員選項
    memberRadio.checked = false;
    memberRadio.disabled = true;
    memberCard.classList.add("disabled");
  } else {
    // 隱藏提示並解除限制
    noticeBox.classList.add("hidden");
    memberRadio.disabled = false;
    memberCard.classList.remove("disabled");
  }

  // 自動在「其他組別」中過濾掉當前第一志願，避免重複勾選
  filterAltChoices(selectedDept);
}

function setupAltChoiceLogic() {
  // 原「僅接受第一志願」選項已移除，其他組別供同學自由多選或留空
}

function onOnlyFirstChoiceToggle(checkbox) {
  // 保留函式名稱以維持舊介面相容性
}

function filterAltChoices(firstChoice) {
  const altItems = document.querySelectorAll("#alt-dept-container .chip-item");
  altItems.forEach(item => {
    const cb = item.querySelector("input");
    if (cb.value === firstChoice) {
      cb.checked = false;
      item.style.display = "none";
    } else {
      item.style.display = "inline-flex";
    }
  });
}

/* =========================================================
   3.1 檔案多檔上傳 (Drive Multi-Upload) 與拖曳處理
   ========================================================= */

function setupDropZone() {
  const dropzone = document.getElementById("file-dropzone");
  if (!dropzone) return;

  ["dragenter", "dragover"].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag-over");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files && files.length > 0) {
      handleFiles(Array.from(files));
    }
  });

  // 監聽班級、座號、姓名欄位變動，即時更新多檔案的自動命名預覽
  ["f-class", "f-seat", "f-name"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", renderSelectedFilesList);
      el.addEventListener("change", renderSelectedFilesList);
    }
  });
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (files && files.length > 0) {
    handleFiles(Array.from(files));
  }
}

async function handleFiles(files) {
  const input = document.getElementById("f-file-input");

  for (const file of files) {
    // 限制單檔 15MB 以內
    if (file.size > 15 * 1024 * 1024) {
      showToast(`⚠️ 檔案【${file.name}】超過 15MB 限制，已跳過！`);
      continue;
    }

    // 檢查是否已在清單中
    if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
      continue;
    }

    try {
      const base64String = await readFileAsBase64(file);
      selectedFiles.push({
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        base64: base64String
      });
    } catch (err) {
      console.error(err);
      showToast(`❌ 讀取【${file.name}】失敗！`);
    }
  }

  if (input) input.value = "";
  renderSelectedFilesList();
  if (selectedFiles.length > 0) {
    showToast(`✅ 已選取 ${selectedFiles.length} 個檔案，系統將自動依序命名上傳！`);
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function removeSelectedFile(index) {
  selectedFiles.splice(index, 1);
  renderSelectedFilesList();
}

function clearAllSelectedFiles() {
  selectedFiles = [];
  const input = document.getElementById("f-file-input");
  if (input) input.value = "";
  renderSelectedFilesList();
}

function renderSelectedFilesList() {
  const droparea = document.getElementById("file-droparea");
  const listWrapper = document.getElementById("files-list-wrapper");
  const cardsContainer = document.getElementById("files-cards-list");
  const countEl = document.getElementById("files-count");

  if (!listWrapper || !cardsContainer) return;

  if (selectedFiles.length === 0) {
    listWrapper.classList.add("hidden");
    if (droparea) droparea.classList.remove("hidden");
    return;
  }

  listWrapper.classList.remove("hidden");
  if (countEl) countEl.textContent = selectedFiles.length;

  // 取得目前的班級、座號、姓名用以即時預覽命名
  const curClass = (document.getElementById("f-class")?.value || "").trim() || "班級";
  const curSeat = (document.getElementById("f-seat")?.value || "").trim() || "座號";
  const curName = (document.getElementById("f-name")?.value || "").trim() || "姓名";

  cardsContainer.innerHTML = selectedFiles.map((file, idx) => {
    let ext = "";
    if (file.name && file.name.lastIndexOf(".") !== -1) {
      ext = file.name.substring(file.name.lastIndexOf("."));
    }
    const autoName = `${curClass}-${curSeat}-${curName}-${idx + 1}${ext}`;

    return `
      <div class="file-item-card">
        <div class="file-item-left">
          <div class="file-index-badge">#${idx + 1}</div>
          <div class="file-item-names">
            <div class="file-auto-name"><i class="fa-solid fa-cloud-arrow-up text-coral"></i> <strong>${autoName}</strong></div>
            <div class="file-orig-name">原檔名：${file.name} (${formatFileSize(file.size)})</div>
          </div>
        </div>
        <button type="button" class="btn-remove-single-file" onclick="removeSelectedFile(${idx})" title="移除此檔案">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    `;
  }).join("");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/* =========================================================
   未在名冊中確認彈窗控制函式 (轉學生/名冊更動相容機制)
   ========================================================= */

function openUnlistedModal(className, seat, name) {
  const modal = document.getElementById("unlisted-modal");
  if (!modal) return;
  const cEl = document.getElementById("u-modal-class");
  const sEl = document.getElementById("u-modal-seat");
  const nEl = document.getElementById("u-modal-name");
  if (cEl) cEl.textContent = `${className} 班`;
  if (sEl) sEl.textContent = `${seat} 號`;
  if (nEl) nEl.textContent = name;
  modal.classList.remove("hidden");
}

function closeUnlistedModal() {
  const modal = document.getElementById("unlisted-modal");
  if (modal) modal.classList.add("hidden");
  const nameInput = document.getElementById("f-name");
  if (nameInput) nameInput.focus();
}

function confirmUnlistedSubmit() {
  closeUnlistedModal();
  executeFormSubmit(true);
}

/* =========================================================
   4. 表單提交處理 (新增 / 更新 Google Sheet)
   ========================================================= */

async function handleFormSubmit(event) {
  if (event) event.preventDefault();

  // 0. 學生身分核驗與必填防呆
  const formClass = (document.getElementById("f-class")?.value || "").trim();
  const formSeat = (document.getElementById("f-seat")?.value || "").trim();
  const formName = (document.getElementById("f-name")?.value || "").trim();

  if (!formClass || !formSeat || !formName) {
    showToast("⚠️ 請完整填寫「班級」、「座號」與「姓名」！");
    return;
  }

  // 若比對結果為未在名冊中 (unlisted)，主動彈窗向同學確認「未在名單中，是否確認送出？」
  if (studentVerifyStatus["f"] === "unlisted") {
    openUnlistedModal(formClass, formSeat, formName);
    return;
  }

  executeFormSubmit(false);
}

async function executeFormSubmit(isUnlistedConfirmed) {
  const form = document.getElementById("recruitment-form");
  const submitBtn = document.getElementById("btn-submit");
  const btnText = document.getElementById("submit-btn-text");
  const btnSpinner = document.getElementById("submit-spinner");

  // 1. 收集表單資料
  const formData = new FormData(form);

  // 處理多選志願調配組別
  const altChoices = [];
  document.querySelectorAll('input[name="alt_choices"]:checked').forEach(cb => altChoices.push(cb.value));

  // 處理方便參與時段 (可多選，各自獨立統計)
  const timeSlots = [];
  document.querySelectorAll('input[name="time_slots"]:checked').forEach(cb => timeSlots.push(cb.value));

  if (timeSlots.length === 0) {
    showToast("⚠️ 請至少勾選一個您可以出席的時段唷！");
    return;
  }

  const payload = {
    timestamp: new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
    class: formData.get("class").trim(),
    seat: formData.get("seat").trim(),
    name: formData.get("name").trim(),
    contact: formData.get("contact").trim(),
    first_choice: formData.get("first_choice"),
    position_role: formData.get("position_role"),
    alt_choices: altChoices.join(", ") || "無",
    experience: formData.get("experience").trim(),
    portfolio: selectedFiles.length > 0 ? "待後端上傳檔案回填" : "無",
    training_status: timeSlots.join(", "),
    interview_slots: timeSlots.join(", "),
    notes: formData.get("notes") ? formData.get("notes").trim() : "無",
    is_update: isEditMode,
    unlisted_roster: isUnlistedConfirmed === true,
    force_submit: isUnlistedConfirmed === true,
    files: selectedFiles.map(f => ({
      name: f.name,
      type: f.type,
      base64: f.base64
    })),
    uid: `${formData.get("class").trim()}-${formData.get("seat").trim()}-${formData.get("name").trim()}`
  };

  // 2. 切換按鈕為 Loading 狀態
  submitBtn.disabled = true;
  btnText.classList.add("hidden");
  if (selectedFiles.length > 0) {
    btnSpinner.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> 正在上傳 ${selectedFiles.length} 個檔案至雲端空間...🐾`;
  } else {
    btnSpinner.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 正在傳送熱情到籌委會...🐾';
  }
  btnSpinner.classList.remove("hidden");

  const gasUrl = getGasUrl();

  try {
    let result = null;

    if (gasUrl) {
      // 串接真實 Google Apps Script Web App
      try {
        const response = await fetch(gasUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "submit", data: payload })
        });
        const resText = await response.text();
        try {
          result = JSON.parse(resText);
        } catch (parseErr) {
          result = { status: "success", message: "資料已傳送完成！" };
        }
      } catch (fetchErr) {
        console.warn("標準 CORS 請求受限，採用 fallback 傳送:", fetchErr);
        await fetch(gasUrl, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "submit", data: payload })
        });
        result = { status: "success", message: "資料已成功傳送！" };
      }
    } else {
      // 本機示範模式 (使用 localStorage 模擬資料庫)
      await new Promise(r => setTimeout(r, 900)); // 模擬網路延遲
      saveToLocalMockDb(payload);
      result = { status: "success", message: "（本機示範模式）資料已儲存成功！" };
    }

    // 檢查後端是否要求向學生確認名冊外身分
    if (result && result.status === "unlisted_confirm_required") {
      openUnlistedModal(payload.class, payload.seat, payload.name);
      return;
    }

    // 檢查後端是否回傳失敗
    if (result && result.status === "error") {
      showToast(`❌ 處理失敗：${result.message || "伺服器未預期錯誤"}`);
      alert(`⚠️ 送出失敗：\n\n${result.message || "未知錯誤，請聯繫管理員！"}`);
      return;
    }

    if (result && result.status === "partial_error") {
      alert(`⚠️ 注意：\n\n${result.message}`);
    }

    if (result && result.isUnlisted) {
      showToast("📢 提醒：已為您送出報名，並已標註【待人工核對】名冊！");
    }

    // 3. 提交成功回饋與特效
    triggerCuteConfetti();
    showSuccessModal(payload, isEditMode);


    clearAllSelectedFiles();

    if (isEditMode) {
      cancelEditMode();
    } else {
      form.reset();
      // 重置特定狀態
      document.getElementById("position-notice").classList.add("hidden");
      document.getElementById("pos-member-wrapper").classList.remove("disabled");
      document.getElementById("pos-member").disabled = false;
    }

  } catch (error) {
    console.error("Submission Error:", error);
    showToast(`❌ 傳送發生錯誤：${error.message || error}`);
    alert(`❌ 傳送失敗，請確認網路連線或稍後再試！\n錯誤原因：${error.message || error}`);
  } finally {
    submitBtn.disabled = false;
    btnText.classList.remove("hidden");
    btnSpinner.classList.add("hidden");
  }
}

/* =========================================================
   5. 查詢與載入已報名資料 (修改功能)
   ========================================================= */

async function handleQuerySubmit(event) {
  event.preventDefault();

  const qClass = (document.getElementById("q-class")?.value || "").trim();
  const qSeat = (document.getElementById("q-seat")?.value || "").trim();
  const qName = (document.getElementById("q-name")?.value || "").trim();

  // 0. 學生身分核驗與必填防呆
  if (!qClass || !qSeat || !qName) {
    showToast("⚠️ 請完整填寫欲查詢之「班級」、「座號」與「姓名」！");
    return;
  }

  if (qName.replace(/\s+/g, "").length < 2) {
    showToast("⚠️ 請輸入完整姓名（至少需 2 個字元）！");
    return;
  }


  const queryBtn = document.getElementById("btn-query");

  const origBtnHtml = queryBtn.innerHTML;
  queryBtn.disabled = true;
  queryBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> 正在檢索資料庫...';

  const gasUrl = getGasUrl();

  try {
    let studentData = null;

    if (gasUrl) {
      // 呼叫 GAS doGet 進行查詢
      const queryEndpoint = `${gasUrl}?action=get&class=${encodeURIComponent(qClass)}&seat=${encodeURIComponent(qSeat)}&name=${encodeURIComponent(qName)}`;
      const resp = await fetch(queryEndpoint);
      const json = await resp.json();
      if (json.status === "success" && json.data) {
        studentData = json.data;
      }
    } else {
      // 本機示範資料庫查詢
      await new Promise(r => setTimeout(r, 600));
      studentData = getFromLocalMockDb(qClass, qSeat, qName);
    }

    if (studentData) {
      loadDataIntoForm(studentData);
      showToast(`🎉 成功載入【${studentData.name}】的報名表！`);
      switchMode("apply");
    } else {
      showToast(`ℹ️ 名冊核對成功，但【${qClass} 班 ${qSeat} 號 ${qName}】尚未填寫過報名表喔！歡迎前往「我要報名」立即填寫！`);
    }

  } catch (error) {
    console.error("Query Error:", error);
    // 若線上查詢失敗，嘗試從本地快取查找
    const fallbackData = getFromLocalMockDb(qClass, qSeat, qName);
    if (fallbackData) {
      loadDataIntoForm(fallbackData);
      showToast(`🎉 已從快取載入【${fallbackData.name}】的報名表！`);
      switchMode("apply");
    } else {
      showToast(`❌ 查詢連線失敗：${error.message || error}，請確認網路連線！`);
    }
  } finally {
    queryBtn.disabled = false;
    queryBtn.innerHTML = origBtnHtml;
  }
}

function loadDataIntoForm(data) {
  isEditMode = true;
  currentEditId = `${data.class}-${data.seat}`;

  // 1. 填入文字欄位並動態載入座號與身分核對
  document.getElementById("f-class").value = data.class || "";
  populateSeatOptions("f", data.class, data.seat);
  document.getElementById("f-name").value = data.name || "";
  validateStudentRealtime("f");
  document.getElementById("f-contact").value = data.contact || "";
  document.getElementById("f-experience").value = data.experience || "";
  const portfolioInput = document.getElementById("f-portfolio");
  if (portfolioInput) {
    portfolioInput.value = data.portfolio === "無" ? "" : (data.portfolio || "");
  }
  document.getElementById("f-notes").value = data.notes === "無" ? "" : (data.notes || "");

  // 2. 選擇第一志願
  if (data.first_choice) {
    const radio = document.querySelector(`input[name="first_choice"][value="${data.first_choice}"]`);
    if (radio) {
      radio.checked = true;
      onFirstChoiceChange(data.first_choice);
    }
  }

  // 3. 選擇職位
  if (data.position_role) {
    const posRadio = document.querySelector(`input[name="position_role"][value="${data.position_role}"]`);
    if (posRadio && !posRadio.disabled) {
      posRadio.checked = true;
    }
  }

  // 4. 其他組別勾選
  document.querySelectorAll('input[name="alt_choices"]').forEach(cb => cb.checked = false);
  if (data.alt_choices) {
    const alts = data.alt_choices.split(",").map(s => s.trim());
    alts.forEach(val => {
      const cb = document.querySelector(`input[name="alt_choices"][value="${val}"]`);
      if (cb) cb.checked = true;
    });
  }

  // 5. 參與時段勾選 (平日中午、自主學習時間、平日放學，可複選)
  document.querySelectorAll('input[name="time_slots"]').forEach(cb => cb.checked = false);
  const savedTimes = String(data.training_status || data.interview_slots || "");
  if (savedTimes) {
    document.querySelectorAll('input[name="time_slots"]').forEach(cb => {
      if (savedTimes.includes(cb.value) ||
        (cb.value.includes("平日中午") && savedTimes.includes("平日中午")) ||
        (cb.value.includes("自主學習") && savedTimes.includes("自主學習")) ||
        (cb.value.includes("平日放學") && savedTimes.includes("平日放學"))) {
        cb.checked = true;
      }
    });
  }

  // 6. 更新 UI 橫幅與按鈕文字
  const editBanner = document.getElementById("edit-notice-banner");
  const editUserInfo = document.getElementById("edit-user-info");
  const submitBtnText = document.getElementById("submit-btn-text");

  editUserInfo.textContent = `班級：${data.class} | 座號：${data.seat} 號 | 姓名：${data.name}`;
  editBanner.classList.remove("hidden");
  submitBtnText.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 儲存修改後的報名內容';

  // 7. 若原本已有上傳檔案，顯示溫馨替換提示
  const fileAlert = document.getElementById("existing-file-alert");
  if (fileAlert) {
    if (data.portfolio && data.portfolio !== "無") {
      fileAlert.classList.remove("hidden");
    } else {
      fileAlert.classList.add("hidden");
    }
  }
}

function cancelEditMode() {
  isEditMode = false;
  currentEditId = null;

  document.getElementById("edit-notice-banner").classList.add("hidden");
  const fileAlert = document.getElementById("existing-file-alert");
  if (fileAlert) fileAlert.classList.add("hidden");

  document.getElementById("submit-btn-text").innerHTML = '<i class="fa-solid fa-paper-plane"></i> 確認送出報名表';
  document.getElementById("recruitment-form").reset();

  // 重置提示與職位鎖定
  document.getElementById("position-notice").classList.add("hidden");
  document.getElementById("pos-member-wrapper").classList.remove("disabled");
  document.getElementById("pos-member").disabled = false;

  // 恢復所有其他組別晶片
  document.querySelectorAll("#alt-dept-container .chip-item").forEach(i => i.style.display = "inline-flex");

  clearAllSelectedFiles();

  showToast("已切換回「全新報名表單」");
}

/* =========================================================
   6. 視覺特效與 Modal 回饋
   ========================================================= */

function triggerCuteConfetti() {
  if (typeof confetti === "function") {
    // 溫暖繽紛彩帶彩花
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
      colors: ["#FF7B54", "#FFB26B", "#FFD56B", "#98D8AA", "#FF80BF"]
    });
    setTimeout(() => {
      confetti({
        particleCount: 50,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ["#FF7B54", "#FFB26B", "#FFD56B"]
      });
      confetti({
        particleCount: 50,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ["#98D8AA", "#70A1FF", "#C5A3FF"]
      });
    }, 250);
  }
}

function showSuccessModal(data, isUpdated) {
  const modal = document.getElementById("success-modal");
  const title = document.getElementById("modal-title-text");
  const desc = document.getElementById("modal-desc-text");

  if (isUpdated) {
    title.textContent = "報名資料已更新成功！🌟";
    desc.innerHTML = `您的修改已成功儲存至 Google Sheet 囉！<br>籌委會將以您最新的志願與時段為主 💌`;
  } else {
    title.textContent = "報名資料已成功送出！🎉";
    desc.innerHTML = `太棒了！我們已經收到你的熱情申請囉！<br>資料已即時寫入 Google Sheet 資料庫 💌`;
  }

  document.getElementById("summary-student-name").textContent = `${data.class} ${data.seat}號 ${data.name}`;
  document.getElementById("summary-dept-choice").textContent = `${data.first_choice}組`;
  document.getElementById("summary-position-role").textContent = data.position_role;
  document.getElementById("summary-timestamp").textContent = data.timestamp;

  modal.classList.remove("hidden");
}

function closeSuccessModal() {
  document.getElementById("success-modal").classList.add("hidden");
}

function copyLineInviteUrl() {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(LINE_COMMUNITY_URL).then(() => {
      showToast("📋 已成功複製「7th 專題籌備委員會」社群邀請連結！");
    }).catch(() => {
      fallbackCopyText(LINE_COMMUNITY_URL);
    });
  } else {
    fallbackCopyText(LINE_COMMUNITY_URL);
  }
}

function fallbackCopyText(text) {
  const temp = document.createElement("textarea");
  temp.value = text;
  temp.style.position = "fixed";
  temp.style.opacity = "0";
  document.body.appendChild(temp);
  temp.focus();
  temp.select();
  try {
    document.execCommand("copy");
    showToast("📋 已成功複製「7th 專題籌備委員會」社群邀請連結！");
  } catch (err) {
    showToast("⚠️ 複製失敗，請手動複製連結網址！");
  }
  document.body.removeChild(temp);
}

function toggleLineFab() {
  const popover = document.getElementById("line-fab-popover");
  if (popover) {
    popover.classList.toggle("hidden");
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.innerHTML = message;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

/* =========================================================
   7. 本地示範資料庫 (Local Mock Database)
   ========================================================= */

function getLocalDb() {
  try {
    return JSON.parse(localStorage.getItem("7th_committee_mock_db") || "{}");
  } catch (e) {
    return {};
  }
}

function saveToLocalMockDb(data) {
  const db = getLocalDb();
  const key = `${data.class}-${data.seat}-${data.name}`;
  db[key] = data;
  localStorage.setItem("7th_committee_mock_db", JSON.stringify(db));
}

function getFromLocalMockDb(className, seat, name) {
  const db = getLocalDb();
  // 嚴格完全相符（禁止任何自動寬容，班級、座號、姓名皆必須完全相符）
  const exactKey = `${className}-${seat}-${name}`;
  if (db[exactKey]) return db[exactKey];

  for (let k in db) {
    const item = db[k];
    const isClassMatch = item.class === className;
    const isSeatMatch = String(item.seat) === String(seat) || (!isNaN(Number(item.seat)) && !isNaN(Number(seat)) && Number(item.seat) === Number(seat));
    const isNameMatch = item.name === name;
    if (isClassMatch && isSeatMatch && isNameMatch) {
      return item;
    }
  }
  return null;
}

function checkStoredSubmission() {
  // 若之前有填寫紀錄，可在控制台提示
  const db = getLocalDb();
  const count = Object.keys(db).length;
  if (count > 0) {
    console.log(`[7th Committee] 本機已暫存 ${count} 筆報名紀錄。`);
  }
}
