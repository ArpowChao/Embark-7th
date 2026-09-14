// =========================================================================
// 第七屆專題籌備委員會 - Google Apps Script (GAS) 後端處理程式
// =========================================================================

// 綁定指定 Google 試算表 ID 與 Google Drive 作品集上傳資料夾 ID
const SPREADSHEET_ID = "1VmMxK6BNoiq8KQL0xqWY3jexgeuh8yPjPSQXgBQ_e-U";
const UPLOAD_FOLDER_ID = "1IWY248Kxp7at92PIZnwhVpSeMBsx0PG4";

// 定義 Google Sheet 工作表名稱
const SHEET_NAME = "報名名單";

// 🔐 定義學生名冊私有工作表名稱 (存放於管理員私有 Google 試算表中，絕不公開於前端，嚴格保護個資)
const ROSTER_SHEET_NAME = "學生名冊";


// 定義表頭欄位清單
const HEADERS = [
  "報名時間",
  "最後更新時間",
  "班級",
  "座號",
  "姓名",
  "聯絡方式",
  "第一志願組別",
  "欲擔任職位",
  "其他可接受組別",
  "相關經歷與簡介",
  "作品集/佐證連結",
  "10~11月培訓期配合度",
  "面試方便時段",
  "給籌委會的一句話/備註",
  "唯一識別碼 (班級-座號)"
];

/**
 * 取得或建立目標工作表 (支援主動開啟指定試算表或容器綁定)
 */
function getTargetSheet() {
  let ss = null;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (e) {}
  if (!ss && SPREADSHEET_ID) {
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    } catch (e) {
      console.error("Open by ID error:", e);
    }
  }
  if (!ss) {
    throw new Error("無法連線至 Google 試算表，請確認 SPREADSHEET_ID 或試算表存取權限！");
  }
  
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    setupHeaders(sheet);
  } else if (sheet.getLastRow() === 0) {
    setupHeaders(sheet);
  }
  return sheet;
}

/**
 * 初始化工作表表頭與美化排版
 */
function setupHeaders(sheet) {
  sheet.appendRow(HEADERS);
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  
  // 溫馨橘黃色系表頭排版
  headerRange.setBackground("#FF8A5B")
             .setFontColor("#FFFFFF")
             .setFontWeight("bold")
             .setFontSize(11)
             .setHorizontalAlignment("center")
             .setVerticalAlignment("middle");
  
  sheet.setRowHeight(1, 36);
  sheet.setFrozenRows(1);
  
  // 自動調整欄寬
  for (let i = 1; i <= HEADERS.length; i++) {
    sheet.setColumnWidth(i, 150);
  }
}

/**
 * 處理 POST 請求 (新增或修改報名資料)
 */
function doPost(e) {
  try {
    let requestData = {};
    
    // 解析傳入的 JSON 內容
    if (e.postData && e.postData.contents) {
      requestData = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      requestData = e.parameter;
    }

    const action = requestData.action || "submit";
    const data = requestData.data || requestData;

    if (action === "submit") {
      const sheet = getTargetSheet();
      const rows = sheet.getDataRange().getValues();
      
      const targetClass = String(data.class).trim();
      const targetSeat = String(data.seat).trim();
      const targetName = String(data.name || "").trim();
      const targetUid = `${targetClass}-${targetSeat}`;
      const nowTime = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

      // 🔐 學生個資保護與身分防呆：在雲端伺服器端核對私有名冊 (若已建置學生名冊工作表)
      const ss = sheet.getParent();
      const rosterCheck = verifyStudentRecord(ss, targetClass, targetSeat, targetName);
      let isUnlistedStudent = false;

      if (rosterCheck.hasRoster && !rosterCheck.verified) {
        // 若學生未在預設名冊中，檢查是否已確認送出 (轉學生/名冊異動相容彈性機制)
        if (data.unlisted_roster || data.force_submit) {
          isUnlistedStudent = true;
          const unlistedTag = "【⚠️ 未在名冊中-待人工核對】";
          if (!data.notes || data.notes === "無") {
            data.notes = unlistedTag;
          } else if (!data.notes.includes(unlistedTag)) {
            data.notes = `${unlistedTag} ${data.notes}`;
          }
        } else {
          return createJsonResponse({
            status: "unlisted_confirm_required",
            message: "您的班級、座號或姓名未在名單中，是否確認送出？"
          });
        }
      }


      
      let existingRowIndex = -1;
      
      // 搜尋是否已有相同 班級 + 座號 的紀錄 (從第 2 列開始尋找)
      for (let i = 1; i < rows.length; i++) {
        const rowClass = String(rows[i][2]).trim();
        const rowSeat = String(rows[i][3]).trim();
        const isSeatMatch = rowSeat === targetSeat || (Number(rowSeat) === Number(targetSeat) && !isNaN(Number(targetSeat)));
        if (rowClass === targetClass && isSeatMatch) {
          existingRowIndex = i + 1; // 工作表列索引從 1 開始
          break;
        }
      }

      // 處理直接上傳檔案至指定 Google Drive 資料夾 (支援多個檔案，自動以 班級-座號-姓名-1, -2, -3 命名)
      const filesToUpload = data.files || (data.file ? [data.file] : []);
      let uploadedDriveUrls = [];

      if (Array.isArray(filesToUpload) && filesToUpload.length > 0) {
        try {
          const folder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);

          // 🌟 智慧替換機制：若學生是修改資料且上傳新檔案，自動將該同學先前傳錯的舊檔案移至垃圾桶，乾淨更新！
          if (existingRowIndex > 0) {
            try {
              const prefix = `${targetClass}-${targetSeat}-${targetName}-`;
              const existingFiles = folder.getFiles();
              while (existingFiles.hasNext()) {
                const oldF = existingFiles.next();
                if (oldF.getName().startsWith(prefix)) {
                  oldF.setTrashed(true); // 移至垃圾桶，避免傳錯檔案外流或混淆
                }
              }
            } catch (trashErr) {
              console.warn("清理舊檔案警告:", trashErr);
            }
          }

          filesToUpload.forEach((fileItem, idx) => {
            if (fileItem && fileItem.base64) {
              const decodedBytes = Utilities.base64Decode(fileItem.base64);
              let ext = "";
              if (fileItem.name && fileItem.name.lastIndexOf(".") !== -1) {
                ext = fileItem.name.substring(fileItem.name.lastIndexOf("."));
              }
              // 自動依據班級座號姓名命名，多檔案以 -1 -2 -3 區分
              const autoFileName = `${targetClass}-${targetSeat}-${targetName}-${idx + 1}${ext}`;
              const mimeType = fileItem.type || "application/octet-stream";
              const blob = Utilities.newBlob(decodedBytes, mimeType, autoFileName);
              const newFile = folder.createFile(blob);
              try {
                newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
              } catch (shareErr) {
                // 若受限於學校 Google Workspace 網域政策無法公開，略過即可，不影響檔案正常存入資料夾
              }
              uploadedDriveUrls.push(newFile.getUrl());
            }
          });
        } catch (uploadErr) {
          console.error("Drive upload failed:", uploadErr);
          uploadedDriveUrls.push(`(檔案上傳失敗: ${uploadErr.message})`);
        }
      } else if (data.clear_files && existingRowIndex > 0) {
        // 若學生選擇撤回/清除先前已上傳的檔案
        try {
          const folder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
          const prefix = `${targetClass}-${targetSeat}-${targetName}-`;
          const existingFiles = folder.getFiles();
          while (existingFiles.hasNext()) {
            const oldF = existingFiles.next();
            if (oldF.getName().startsWith(prefix)) {
              oldF.setTrashed(true);
            }
          }
        } catch (trashErr) {}
      }

      // 檔案連結寫入作品集/佐證欄位
      if (uploadedDriveUrls.length > 0) {
        data.portfolio = uploadedDriveUrls.join("\n");
      } else if (data.clear_files) {
        data.portfolio = "無";
      } else if (existingRowIndex > 0) {
        // 若為更新現有紀錄且本次並未重新上傳檔案，自動保留原先已上傳之作品集連結，絕不清空！
        const prevPortfolio = rows[existingRowIndex - 1][10];
        data.portfolio = (prevPortfolio && String(prevPortfolio).trim()) ? String(prevPortfolio).trim() : "無";
      } else if (!data.portfolio || data.portfolio === "待後端上傳檔案回填") {
        data.portfolio = "無";
      }

      const rowData = [
        existingRowIndex > 0 ? (rows[existingRowIndex - 1][0] || nowTime) : nowTime,
        nowTime,
        data.class,
        data.seat,
        data.name,
        data.contact,
        data.first_choice,
        data.position_role,
        data.alt_choices,
        data.experience,
        data.portfolio,
        data.training_status,
        data.interview_slots,
        data.notes,
        targetUid
      ];

      if (existingRowIndex > 0) {
        // 更新現有資料
        sheet.getRange(existingRowIndex, 1, 1, rowData.length).setValues([rowData]);
      } else {
        // 新增全新一筆報名
        sheet.appendRow(rowData);
      }

      const hasUploadFailure = uploadedDriveUrls.some(u => String(u).includes("檔案上傳失敗"));
      if (hasUploadFailure) {
        const failDetail = uploadedDriveUrls.filter(u => String(u).includes("檔案上傳失敗")).join(" | ");
        return createJsonResponse({
          status: "partial_error",
          message: "⚠️ 報名資料已存入試算表，但檔案上傳雲端硬碟失敗：" + failDetail,
          isUpdate: existingRowIndex > 0,
          data: data
        });
      }

      return createJsonResponse({
        status: "success",
        message: existingRowIndex > 0 ? "報名資料已成功更新！" : "報名資料已成功新增！",
        isUpdate: existingRowIndex > 0,
        isUnlisted: isUnlistedStudent,
        data: data
      });
    }

    return createJsonResponse({ status: "error", message: "未知的 Action 請求" });

  } catch (error) {
    console.error("doPost Error:", error);
    return createJsonResponse({
      status: "error",
      message: "後端處理失敗: " + (error.message || error.toString())
    });
  }
}

/**
 * 處理 GET 請求 (查詢特定學生報名紀錄)
 */
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action;

    if (action === "get") {
      const qClass = String(params.class || "").trim();
      const qSeat = String(params.seat || "").trim();
      const qName = String(params.name || "").trim();

      if (!qClass || !qSeat || !qName) {
        return createJsonResponse({ 
          status: "not_found", 
          message: "請完整提供【班級】、【座號】與【姓名】進行查詢！" 
        });
      }

      const sheet = getTargetSheet();
      const rows = sheet.getDataRange().getValues();

      if (rows.length <= 1) {
        return createJsonResponse({ status: "not_found", message: "目前尚無任何報名資料" });
      }

      // 檢索比對：嚴格完全相符（禁止任何自動寬容、禁止異體字猜測、禁止模糊比對）
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rowClass = String(row[2]).trim();
        const rowSeat = String(row[3]).trim();
        const rowName = String(row[4]).trim();

        const isClassMatch = (rowClass === qClass);
        const isSeatMatch = (rowSeat === qSeat) || (!isNaN(Number(rowSeat)) && !isNaN(Number(qSeat)) && Number(rowSeat) === Number(qSeat));
        const isNameMatch = (rowName === qName);

        if (isClassMatch && isSeatMatch && isNameMatch) {
          const studentData = {
            timestamp: row[0],
            last_updated: row[1],
            class: row[2],
            seat: row[3],
            name: row[4],
            contact: row[5],
            first_choice: row[6],
            position_role: row[7],
            alt_choices: row[8],
            experience: row[9],
            portfolio: row[10],
            training_status: row[11],
            interview_slots: row[12],
            notes: row[13]
          };

          return createJsonResponse({
            status: "success",
            data: studentData
          });
        }
      }

      return createJsonResponse({
        status: "not_found",
        message: "查無此報名資料，請確認班級、座號與姓名是否完全相符。"
      });
    }

    // 🔐 學生名冊線上安全即時比對 API (僅回傳吻合與否，絕不對外洩漏名冊清單或他人姓名)
    if (action === "verifyStudent") {
      const qClass = String(params.class || "").trim();
      const qSeat = String(params.seat || "").trim();
      const qName = String(params.name || "").trim();

      if (!qClass || !qSeat || !qName) {
        return createJsonResponse({ 
          status: "error", 
          verified: false, 
          message: "請完整提供【班級】、【座號】與【姓名】進行比對！" 
        });
      }

      const sheet = getTargetSheet();
      const ss = sheet.getParent();
      const check = verifyStudentRecord(ss, qClass, qSeat, qName);

      if (!check.hasRoster) {
        return createJsonResponse({
          status: "success",
          verified: true,
          hasRoster: false,
          message: "尚未建置名冊，預設放行"
        });
      }

      if (check.verified) {
        return createJsonResponse({
          status: "success",
          verified: true,
          hasRoster: true,
          message: "名冊核對吻合"
        });
      } else {
        return createJsonResponse({
          status: "error",
          verified: false,
          hasRoster: true,
          message: check.message || "❌ 名冊查無此人"
        });
      }
    }

    // 若直接開啟網址，顯示正常運行訊息
    return ContentService.createTextOutput("🌸 第七屆專題籌備委員會 Google Apps Script API 正常運行中！");

  } catch (error) {
    return createJsonResponse({
      status: "error",
      message: error.toString()
    });
  }
}

/**
 * 依據管理員私有「學生名冊」工作表核對身分 (保護學生個資，嚴防查無此人或冒名)
 * 工作表欄位格式：A欄: 班級, B欄: 座號, C欄: 姓名
 */
function verifyStudentRecord(ss, targetClass, targetSeat, targetName) {
  let rosterSheet = null;
  try {
    rosterSheet = ss.getSheetByName(ROSTER_SHEET_NAME);
  } catch (e) {
    console.warn("無法存取名冊工作表:", e);
  }

  if (!rosterSheet || rosterSheet.getLastRow() <= 1) {
    // 若試算表中尚未建置名冊分頁，採相容策略（允許正常報名，並於後台日誌提示）
    return { verified: true, hasRoster: false, message: "尚未建置學生名冊" };
  }

  const data = rosterSheet.getDataRange().getValues();
  const c = String(targetClass || "").trim();
  const s = String(targetSeat || "").trim();
  const n = String(targetName || "").trim().replace(/\s+/g, "");

  if (!c || !s || !n) {
    return { verified: false, hasRoster: true, message: "班級、座號與姓名不得為空" };
  }

  // 從第 2 列開始尋找 (第 1 列為表頭：班級、座號、姓名)
  for (let i = 1; i < data.length; i++) {
    const rowClass = String(data[i][0]).trim();
    const rowSeat = String(data[i][1]).trim();
    const rowName = String(data[i][2]).trim().replace(/\s+/g, "");

    const isClassMatch = (rowClass === c);
    const isSeatMatch = (rowSeat === s) || (Number(rowSeat) === Number(s) && !isNaN(Number(s)));

    if (isClassMatch && isSeatMatch) {
      if (rowName === n) {
        return { verified: true, hasRoster: true, message: "名冊核對吻合" };
      } else {
        return { 
          verified: false, 
          hasRoster: true, 
          message: `❌ 名冊查無此人：輸入姓名與 ${c} 班 ${s} 號登記不符！` 
        };
      }
    }
  }

  return { 
    verified: false, 
    hasRoster: true, 
    message: `❌ 名冊查無此人：在 ${c} 班名冊中查無 ${s} 號！` 
  };
}

/**
 * 輔助管理員在私有 Google 試算表建立「學生名冊」標準工作表排版
 */
function setupRosterSheetTemplate() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(ROSTER_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ROSTER_SHEET_NAME);
    sheet.appendRow(["班級", "座號", "姓名"]);
    const headerRange = sheet.getRange(1, 1, 1, 3);
    headerRange.setBackground("#4A69BD")
               .setFontColor("#FFFFFF")
               .setFontWeight("bold")
               .setFontSize(11)
               .setHorizontalAlignment("center")
               .setVerticalAlignment("middle");
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 160);
    Logger.log("🎉 已成功在私有 Google 試算表中建立「學生名冊」專用工作表！");
  } else {
    Logger.log("ℹ️ 「學生名冊」工作表已存在。");
  }
}

/**
 * 輔助函式：建立標準 JSON 回傳封裝
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
                       .setMimeType(ContentService.MimeType.JSON);
}


/**
 * =========================================================================
 * 🔑 一鍵觸發 Google Drive 完整寫入（createFile）權限審查函式
 * =========================================================================
 * 請在 Apps Script 編輯器上方函式選單中選擇【authorizeDriveApp】並點擊【執行】，
 * 彈出授權視窗時請點擊「審查權限 ➜ 帳號 ➜ 進階 ➜ 前往專案 ➜ 允許」即可！
 */
function authorizeDriveApp() {
  const folder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  // 建立並隨即移除一個暫存測試檔，強制觸發 Google 彈出「建立與寫入檔案 (createFile)」的完整授權視窗！
  const testFile = folder.createFile("權限開通測試檔.txt", "DriveApp 授權成功");
  testFile.setTrashed(true);
  Logger.log("🎉 Google Drive 完整寫入與上傳權限（createFile）已成功開通！資料夾名稱：" + folder.getName());
}

// ======================= 程式碼結束 (End of File) =======================

