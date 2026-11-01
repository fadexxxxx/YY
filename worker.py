# worker.py
import json
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from workers import Response, WorkerEntrypoint

# ============ 以下 normalize/default 函数，跟你原来的 y.py 一模一样，没有改动 ============

def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")

def ledger_year() -> int:
    return datetime.now().year

def ledger_request_year(query_year=None, body=None) -> int:
    raw = query_year
    if raw in (None, "") and isinstance(body, dict):
        raw = body.get("year")
    try:
        year = int(raw)
    except (TypeError, ValueError):
        year = ledger_year()
    return max(1, min(9999, year))

def _month_days(year: int, month: int) -> int:
    if month == 2:
        return 29 if (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0) else 28
    return 30 if month in (4, 6, 9, 11) else 31

def ledger_default_month(month_index: int = 0, year: int | None = None) -> dict:
    y = year if year is not None else ledger_year()
    days = _month_days(y, month_index + 1)
    return {
        "profit": 0, "sales": 0, "expense": 0,
        "salesBreakdown": {"Check": 0, "cash": 0, "cost": 0, "uber": 0, "riceball": 0, "panda": 0, "bm": 0},
        "totalOverrides": {"Check": None, "uber": None, "riceball": None, "panda": None, "bm": None},
        "salaryRows": [["", "", ""] for _ in range(15)],
        "salaryCheckRows": [["", "", ""] for _ in range(15)],
        "salaryOwe": [["", "", ""] for _ in range(15)],
        "salaryOweNote": "",
        "salaryTotal": 0,
        "othersExpenses": [["", ""] for _ in range(8)],
        "othersTotal": 0,
        "costExpenses": [["", ""] for _ in range(8)],
        "costTotal": 0,
        "cashDays": [""] * days,
        "checkDays": [""] * days,
        "deliveryDetails": {"uber": [], "riceball": [], "panda": [], "bm": [], "dinein": []},
        "checks": [],
        "checkTexts": [],
    }

def ledger_default_payload(year: int | None = None) -> list:
    return [ledger_default_month(i, year) for i in range(12)]

def ledger_normalize_pair_rows(value, rows: int, cols: int) -> list:
    result = []
    source = value if isinstance(value, list) else []
    for i in range(rows):
        row = source[i] if i < len(source) and isinstance(source[i], list) else []
        normalized_row = []
        for j in range(cols):
            cell = row[j] if j < len(row) else ""
            normalized_row.append("" if cell is None else str(cell))
        result.append(normalized_row)
    return result

def ledger_normalize_number_array(value, size: int) -> list:
    result = []
    source = value if isinstance(value, list) else []
    for i in range(size):
        item = source[i] if i < len(source) else ""
        if isinstance(item, bool) or item is None:
            result.append("")
            continue
        if isinstance(item, (int, float)):
            result.append(int(item) if isinstance(item, float) and item.is_integer() else item)
            continue
        if isinstance(item, str):
            text = item.strip().replace(",", "")
            if not text:
                result.append("")
                continue
            if text.lower() == "off":
                result.append("off")
                continue
            try:
                num = float(text)
            except ValueError:
                result.append("")
                continue
            result.append(int(num) if num.is_integer() else num)
            continue
        result.append("")
    return result

def ledger_normalize_text_list(value) -> list:
    if not isinstance(value, list):
        return []
    return ["" if item is None else str(item) for item in value]

def ledger_normalize_checks(value) -> list:
    if not isinstance(value, list):
        return []
    output = []
    for item in value:
        if not isinstance(item, dict):
            continue
        check = {}
        for key in ("name", "no", "caption", "url", "date", "amount"):
            if key in item and item[key] is not None:
                check[key] = item[key]
        if "url" in check:
            output.append(check)
    return output

def ledger_normalize_payload(raw, year: int | None = None) -> list:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    if isinstance(raw, dict):
        if any(str(i) in raw or i in raw for i in range(12)):
            raw = [raw.get(str(i), raw.get(i, {})) for i in range(12)]
        else:
            raw = []
    source = raw if isinstance(raw, list) else []
    normalized = ledger_default_payload(year)
    scalar_fields = ("profit", "sales", "expense", "salaryTotal", "othersTotal", "costTotal")
    sales_keys = ("Check", "cash", "cost", "uber", "riceball", "panda", "bm")
    override_keys = ("Check", "uber", "riceball", "panda", "bm")
    delivery_keys = ("uber", "riceball", "panda", "bm", "dinein")
    for i in range(12):
        item = source[i] if i < len(source) and isinstance(source[i], dict) else {}
        month = normalized[i]
        month_days = _month_days(year or ledger_year(), i + 1)
        for field in scalar_fields:
            if field in item:
                month[field] = item.get(field)
        sales_breakdown = item.get("salesBreakdown")
        if isinstance(sales_breakdown, dict):
            for key in sales_keys:
                if key in sales_breakdown:
                    val = sales_breakdown.get(key)
                    if isinstance(val, str) and not val.strip():
                        val = 0
                    month["salesBreakdown"][key] = val
        total_overrides = item.get("totalOverrides")
        if isinstance(total_overrides, dict):
            for key in override_keys:
                if key in total_overrides:
                    val = total_overrides.get(key)
                    if isinstance(val, str) and not val.strip():
                        val = None
                    month["totalOverrides"][key] = val
        month["salaryRows"] = ledger_normalize_pair_rows(item.get("salaryRows"), 15, 3)
        month["salaryCheckRows"] = ledger_normalize_pair_rows(item.get("salaryCheckRows"), 15, 3)
        month["salaryOwe"] = ledger_normalize_pair_rows(item.get("salaryOwe"), 15, 3)
        month["salaryOweNote"] = "" if item.get("salaryOweNote") is None else str(item.get("salaryOweNote"))
        others_raw = item.get("othersExpenses")
        month["othersExpenses"] = ledger_normalize_pair_rows(others_raw, max(8, len(others_raw) if isinstance(others_raw, list) else 0), 2)
        cost_raw = item.get("costExpenses")
        month["costExpenses"] = ledger_normalize_pair_rows(cost_raw, max(8, len(cost_raw) if isinstance(cost_raw, list) else 0), 2)
        month["cashDays"] = ledger_normalize_number_array(item.get("cashDays"), month_days)
        month["checkDays"] = ledger_normalize_number_array(item.get("checkDays"), month_days)
        delivery = item.get("deliveryDetails")
        if isinstance(delivery, dict):
            for key in delivery_keys:
                month["deliveryDetails"][key] = ledger_normalize_text_list(delivery.get(key))
        month["checks"] = ledger_normalize_checks(item.get("checks"))
        check_texts = item.get("checkTexts")
        month["checkTexts"] = ledger_normalize_pair_rows(check_texts, max(0, len(check_texts) if isinstance(check_texts, list) else 0), 2)
    return normalized

def ledger_z_normalize_records(raw) -> list:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    source = raw if isinstance(raw, list) else []
    records = []
    for item in source:
        if not isinstance(item, dict):
            continue
        date = str(item.get("date") or "").strip()
        if not date:
            continue
        record = {"date": date}
        for key in ("beef", "lamb", "chicken", "wing"):
            value = item.get(key)
            if isinstance(value, bool) or value in (None, ""):
                record[key] = None
                continue
            try:
                num = float(value)
            except (TypeError, ValueError):
                record[key] = None
                continue
            record[key] = num if num else None
        records.append(record)
    return records

CUSTOM_TABLE_DEFAULT_ROWS, CUSTOM_TABLE_DEFAULT_COLS = 8, 6
CUSTOM_TABLE_MIN_ROWS, CUSTOM_TABLE_MIN_COLS = 2, 2
CUSTOM_TABLE_MAX_ROWS, CUSTOM_TABLE_MAX_COLS = 60, 16
CUSTOM_MODULE_DEFAULT_ROWS, CUSTOM_MODULE_DEFAULT_COLS = 4, 6
CUSTOM_MODULE_MIN_ROWS, CUSTOM_MODULE_MIN_COLS = 2, 2
CUSTOM_MODULE_MAX_ROWS, CUSTOM_MODULE_MAX_COLS = 40, 16
CUSTOM_MODULE_MAX_SAVED = 5

def custom_module_default_payload() -> dict:
    rows, cols = CUSTOM_MODULE_DEFAULT_ROWS, CUSTOM_MODULE_DEFAULT_COLS
    cells = []
    total_row = max(0, rows - 1)
    for r in range(rows):
        row = []
        for c in range(cols):
            if r == total_row and c == 0:
                row.append("Total")
            elif r == 0 and c == cols - 1:
                row.append("总额")
            else:
                row.append("")
        cells.append(row)
    return {"title": "模块 1", "rows": rows, "cols": cols, "showTotal": True,
            "showTotalCol": True, "showTotalRow": True, "monthVariables": {}, "cells": cells}

def custom_module_resolve_total_flags(raw: dict) -> dict:
    has_col = isinstance(raw.get("showTotalCol"), bool)
    has_row = isinstance(raw.get("showTotalRow"), bool)
    if has_col or has_row:
        legacy = raw.get("showTotal") if isinstance(raw.get("showTotal"), bool) else True
        return {"showTotalCol": raw["showTotalCol"] if has_col else legacy,
                "showTotalRow": raw["showTotalRow"] if has_row else legacy}
    legacy = raw.get("showTotal") if isinstance(raw.get("showTotal"), bool) else True
    return {"showTotalCol": legacy, "showTotalRow": legacy}

def custom_module_normalize_payload(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    default = custom_module_default_payload()
    if not isinstance(raw, dict):
        return default
    try:
        rows = int(raw.get("rows", default["rows"]))
    except Exception:
        rows = default["rows"]
    try:
        cols = int(raw.get("cols", default["cols"]))
    except Exception:
        cols = default["cols"]
    rows = max(CUSTOM_MODULE_MIN_ROWS, min(CUSTOM_MODULE_MAX_ROWS, rows))
    cols = max(CUSTOM_MODULE_MIN_COLS, min(CUSTOM_MODULE_MAX_COLS, cols))
    cells = ledger_normalize_pair_rows(raw.get("cells"), rows, cols)
    total_flags = custom_module_resolve_total_flags(raw)
    show_total_col, show_total_row = total_flags["showTotalCol"], total_flags["showTotalRow"]
    show_total = show_total_col and show_total_row
    title = str(raw.get("title") or default["title"])
    month_variables = raw.get("monthVariables")
    if not isinstance(month_variables, dict):
        month_variables = {}
    return {"title": title, "rows": rows, "cols": cols, "showTotal": show_total,
            "showTotalCol": show_total_col, "showTotalRow": show_total_row,
            "monthVariables": month_variables, "cells": cells}

def custom_table_default_payload() -> dict:
    rows, cols = CUSTOM_TABLE_DEFAULT_ROWS, CUSTOM_TABLE_DEFAULT_COLS
    cells = []
    for r in range(rows):
        row = []
        for c in range(cols):
            if r == 0 and c == 0:
                row.append("项目")
            elif r == 0:
                row.append(f"列{c}")
            elif c == 0:
                row.append(str(r))
            else:
                row.append("")
        cells.append(row)
    return {"rows": rows, "cols": cols, "cells": cells}

def custom_table_normalize_payload(raw) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = None
    default = custom_table_default_payload()
    if not isinstance(raw, dict):
        return default
    try:
        rows = int(raw.get("rows", default["rows"]))
    except Exception:
        rows = default["rows"]
    try:
        cols = int(raw.get("cols", default["cols"]))
    except Exception:
        cols = default["cols"]
    rows = max(CUSTOM_TABLE_MIN_ROWS, min(CUSTOM_TABLE_MAX_ROWS, rows))
    cols = max(CUSTOM_TABLE_MIN_COLS, min(CUSTOM_TABLE_MAX_COLS, cols))
    cells = ledger_normalize_pair_rows(raw.get("cells"), rows, cols)
    result = {"rows": rows, "cols": cols, "cells": cells}
    layout = str(raw.get("layout") or "single")
    if layout in ("single", "year", "month", "custom"):
        result["layout"] = layout
    sections = raw.get("sections")
    if isinstance(sections, list):
        normalized_sections = []
        for section in sections:
            if not isinstance(section, dict):
                continue
            try:
                section_rows = int(section.get("rows", rows))
            except Exception:
                section_rows = rows
            try:
                section_cols = int(section.get("cols", cols))
            except Exception:
                section_cols = cols
            section_rows = max(CUSTOM_TABLE_MIN_ROWS, min(CUSTOM_TABLE_MAX_ROWS, section_rows))
            section_cols = max(CUSTOM_TABLE_MIN_COLS, min(CUSTOM_TABLE_MAX_COLS, section_cols))
            section_cells = ledger_normalize_pair_rows(section.get("cells"), section_rows, section_cols)
            normalized_sections.append({"title": str(section.get("title") or ""),
                                         "rows": section_rows, "cols": section_cols, "cells": section_cells})
        result["sections"] = normalized_sections
    return result


# ============ 以下是 Workers 专用部分：路由 + D1 ============

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

def json_response(payload: dict, status: int = 200) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        headers={**CORS_HEADERS, "Content-Type": "application/json; charset=utf-8"},
    )

def ipv4_only(value: str) -> str:
    import ipaddress
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return value
    if ip.version == 4:
        return str(ip)
    if ip.version == 6 and getattr(ip, "ipv4_mapped", None):
        return str(ip.ipv4_mapped)
    return ""

async def ensure_year_row(db, year: int):
    row = await db.prepare("SELECT year FROM ledger_data WHERE year = ?").bind(year).first()
    if row:
        return
    await db.prepare(
        "INSERT INTO ledger_data(year, data, panel_z_data, updated) VALUES(?, ?, ?, ?)"
    ).bind(year, json.dumps(ledger_default_payload(year), ensure_ascii=False), "[]", now_iso()).run()


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        env = self.env
        parsed = urlparse(request.url)
        path = parsed.path
        method = request.method
        db = env.DB

        if method == "OPTIONS":
            return Response("", status=204, headers=CORS_HEADERS)

        try:
            if method == "GET" and path == "/ledger/years":
                return await self.h_ledger_years(db)
            if method == "GET" and path == "/ledger/load":
                return await self.h_ledger_load(db, parsed)
            if method == "GET" and path == "/ledger/z/load":
                return await self.h_ledger_z_load(db, parsed)
            if method == "GET" and path == "/custom-table/list":
                return await self.h_custom_table_list(db)
            if method == "GET" and path == "/custom-module/list":
                return await self.h_custom_module_list(db)
            if method == "GET" and path == "/access-log/list":
                return await self.h_access_log_list(db, parsed)
            if method == "GET" and path == "/prefs/load":
                return await self.h_prefs_load(db, parsed)

            if method == "POST" and path == "/ledger/save":
                return await self.h_ledger_save(db, request)
            if method == "POST" and path == "/ledger/delete-year":
                return await self.h_ledger_delete_year(db, request)
            if method == "POST" and path == "/ledger/z/save":
                return await self.h_ledger_z_save(db, request)
            if method == "POST" and path == "/custom-table/save":
                return await self.h_custom_table_save(db, request)
            if method == "POST" and path == "/custom-table/delete":
                return await self.h_custom_table_delete(db, request)
            if method == "POST" and path == "/custom-module/save":
                return await self.h_custom_module_save(db, request)
            if method == "POST" and path == "/custom-module/delete":
                return await self.h_custom_module_delete(db, request)
            if method == "POST" and path == "/access-log/save":
                return await self.h_access_log_save(db, request)
            if method == "POST" and path == "/access-log/delete":
                return await self.h_access_log_delete(db, request)
            if method == "POST" and path == "/access-log/delete-all":
                return await self.h_access_log_delete_all(db)
            if method == "POST" and path == "/prefs/save":
                return await self.h_prefs_save(db, request)
        except Exception as e:
            return json_response({"ok": False, "error": str(e)}, 500)

        # 其余路径（HTML/CSS/JS/图片）交给 Static Assets 处理
        return await env.ASSETS.fetch(request)

    # ---- ledger ----
    async def h_ledger_years(self, db):
        res = await db.prepare("SELECT year FROM ledger_data ORDER BY year DESC").all()
        years = [int(r["year"]) for r in res.results if r.get("year") is not None]
        years = [y for y in years if 1 <= y <= 9999]
        return json_response({"ok": True, "years": years})

    async def h_ledger_load(self, db, parsed):
        year = ledger_request_year(parse_qs(parsed.query).get("year", [None])[0])
        row = await db.prepare("SELECT data, updated FROM ledger_data WHERE year = ?").bind(year).first()
        data = ledger_normalize_payload(json.loads(row["data"]), year) if row and row.get("data") else ledger_default_payload(year)
        updated = row["updated"] if row else now_iso()
        normalized_raw = json.dumps(data, ensure_ascii=False)
        if row and row["data"] != normalized_raw:
            updated = now_iso()
            await db.prepare("UPDATE ledger_data SET data = ?, updated = ? WHERE year = ?").bind(normalized_raw, updated, year).run()
        return json_response({"ok": True, "year": year, "data": data, "updated": updated})

    async def h_ledger_save(self, db, request):
        body = await request.json()
        if body is None:
            return json_response({"ok": False, "error": "no JSON body"}, 400)
        year = ledger_request_year(body=body)
        raw_data = body.get("data") if isinstance(body, dict) and "data" in body else body
        data = ledger_normalize_payload(raw_data, year)
        updated = now_iso()
        await ensure_year_row(db, year)
        await db.prepare("UPDATE ledger_data SET data = ?, updated = ? WHERE year = ?").bind(
            json.dumps(data, ensure_ascii=False), updated, year
        ).run()
        return json_response({"ok": True, "year": year, "data": data, "updated": updated})

    async def h_ledger_delete_year(self, db, request):
        body = (await request.json()) or {}
        year = ledger_request_year(body=body)
        res = await db.prepare("DELETE FROM ledger_data WHERE year = ?").bind(year).run()
        deleted = res.meta.get("changes", 0) if hasattr(res, "meta") else 0
        return json_response({"ok": True, "year": year, "deleted": {"ledger": deleted}})

    async def h_ledger_z_load(self, db, parsed):
        year = ledger_request_year(parse_qs(parsed.query).get("year", [None])[0])
        row = await db.prepare("SELECT panel_z_data, updated FROM ledger_data WHERE year = ?").bind(year).first()
        data = ledger_z_normalize_records(json.loads(row["panel_z_data"])) if row and row.get("panel_z_data") else []
        updated = row["updated"] if row else now_iso()
        normalized_raw = json.dumps(data, ensure_ascii=False)
        if row and row["panel_z_data"] != normalized_raw:
            updated = now_iso()
            await db.prepare("UPDATE ledger_data SET panel_z_data = ?, updated = ? WHERE year = ?").bind(normalized_raw, updated, year).run()
        return json_response({"ok": True, "year": year, "data": data, "updated": updated})

    async def h_ledger_z_save(self, db, request):
        body = await request.json()
        if body is None:
            return json_response({"ok": False, "error": "no JSON body"}, 400)
        year = ledger_request_year(body=body if isinstance(body, dict) else None)
        raw_data = body.get("data") if isinstance(body, dict) and "data" in body else body
        data = ledger_z_normalize_records(raw_data)
        updated = now_iso()
        await ensure_year_row(db, year)
        await db.prepare("UPDATE ledger_data SET panel_z_data = ?, updated = ? WHERE year = ?").bind(
            json.dumps(data, ensure_ascii=False), updated, year
        ).run()
        return json_response({"ok": True, "year": year, "data": data, "updated": updated})

    # ---- custom table ----
    async def h_custom_table_list(self, db):
        res = await db.prepare("SELECT id, position, data, updated FROM custom_tables ORDER BY position ASC, id ASC").all()
        data = [{
            "id": int(r["id"]) if r.get("id") is not None else 0,
            "position": int(r["position"]) if r.get("position") is not None else 0,
            "data": custom_table_normalize_payload(r["data"]),
            "updated": str(r.get("updated") or ""),
        } for r in res.results]
        return json_response({"ok": True, "data": data})

    async def h_custom_table_save(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        raw_id = body.get("id")
        template_id = None
        if raw_id not in (None, ""):
            try:
                template_id = int(raw_id)
            except Exception:
                return json_response({"ok": False, "error": "invalid id"}, 400)
        data = custom_table_normalize_payload(body.get("data"))
        updated = now_iso()

        if template_id:
            row = await db.prepare("SELECT id, position FROM custom_tables WHERE id = ?").bind(template_id).first()
        else:
            row = None

        if row:
            position = int(row["position"])
            await db.prepare("UPDATE custom_tables SET data = ?, updated = ? WHERE id = ?").bind(
                json.dumps(data, ensure_ascii=False), updated, template_id
            ).run()
        else:
            next_row = await db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM custom_tables").first()
            position = int(next_row["next_position"]) if next_row and next_row.get("next_position") is not None else 1
            res = await db.prepare("INSERT INTO custom_tables(position, data, updated) VALUES(?, ?, ?)").bind(
                position, json.dumps(data, ensure_ascii=False), updated
            ).run()
            template_id = int(res.meta["last_row_id"])

        return json_response({"ok": True, "id": template_id, "position": position, "data": data, "updated": updated})

    async def h_custom_table_delete(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        try:
            template_id = int(body.get("id"))
        except Exception:
            return json_response({"ok": False, "error": "invalid id"}, 400)
        if template_id <= 0:
            return json_response({"ok": False, "error": "invalid id"}, 400)
        res = await db.prepare("DELETE FROM custom_tables WHERE id = ?").bind(template_id).run()
        deleted = res.meta.get("changes", 0)
        if deleted <= 0:
            return json_response({"ok": False, "error": "template not found"}, 404)
        return json_response({"ok": True, "id": template_id, "deleted": deleted})

    # ---- custom module ----
    async def h_custom_module_list(self, db):
        res = await db.prepare("SELECT id, position, data, updated FROM custom_modules ORDER BY position ASC, id ASC").all()
        data = [{
            "id": int(r["id"]) if r.get("id") is not None else 0,
            "position": int(r["position"]) if r.get("position") is not None else 0,
            "data": custom_module_normalize_payload(r["data"]),
            "updated": str(r.get("updated") or ""),
        } for r in res.results]
        return json_response({"ok": True, "data": data})

    async def h_custom_module_save(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        raw_id = body.get("id")
        template_id = None
        if raw_id not in (None, ""):
            try:
                template_id = int(raw_id)
            except Exception:
                return json_response({"ok": False, "error": "invalid id"}, 400)
        data = custom_module_normalize_payload(body.get("data"))
        updated = now_iso()

        row = None
        if template_id:
            row = await db.prepare("SELECT id, position FROM custom_modules WHERE id = ?").bind(template_id).first()

        if not row:
            count_row = await db.prepare("SELECT COUNT(*) AS cnt FROM custom_modules").first()
            count = int(count_row["cnt"]) if count_row and count_row.get("cnt") is not None else 0
            if count >= CUSTOM_MODULE_MAX_SAVED:
                return json_response({"ok": False, "error": f"最多保存 {CUSTOM_MODULE_MAX_SAVED} 个模块", "limit": CUSTOM_MODULE_MAX_SAVED}, 400)

        if row:
            position = int(row["position"])
            await db.prepare("UPDATE custom_modules SET data = ?, updated = ? WHERE id = ?").bind(
                json.dumps(data, ensure_ascii=False), updated, template_id
            ).run()
        else:
            used_res = await db.prepare("SELECT position FROM custom_modules ORDER BY position ASC").all()
            used = {int(r["position"]) for r in used_res.results if r.get("position") is not None}
            position = next((p for p in range(1, CUSTOM_MODULE_MAX_SAVED + 1) if p not in used), (max(used) + 1 if used else 1))
            res = await db.prepare("INSERT INTO custom_modules(position, data, updated) VALUES(?, ?, ?)").bind(
                position, json.dumps(data, ensure_ascii=False), updated
            ).run()
            template_id = int(res.meta["last_row_id"])

        return json_response({"ok": True, "id": template_id, "position": position, "data": data, "updated": updated})

    async def h_custom_module_delete(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        try:
            template_id = int(body.get("id"))
        except Exception:
            return json_response({"ok": False, "error": "invalid id"}, 400)
        if template_id <= 0:
            return json_response({"ok": False, "error": "invalid id"}, 400)
        res = await db.prepare("DELETE FROM custom_modules WHERE id = ?").bind(template_id).run()
        deleted = res.meta.get("changes", 0)
        if deleted <= 0:
            return json_response({"ok": False, "error": "template not found"}, 404)
        return json_response({"ok": True, "id": template_id, "deleted": deleted})

    # ---- access log ----
    async def h_access_log_list(self, db, parsed):
        qs = parse_qs(parsed.query)
        try:
            limit = int((qs.get("limit") or ["300"])[0])
        except Exception:
            limit = 300
        limit = max(1, min(limit, 1000))
        res = await db.prepare("SELECT id, time, device, ip, code, op FROM access_logs ORDER BY id DESC LIMIT ?").bind(limit).all()
        data = [{
            "id": int(r["id"]) if r.get("id") is not None else 0,
            "time": str(r.get("time") or ""),
            "device": str(r.get("device") or "Unknown"),
            "ip": ipv4_only(str(r.get("ip") or "")) or "Unknown",
            "code": str(r.get("code") or ""),
            "op": str(r.get("op") or "-"),
        } for r in res.results]
        return json_response({"ok": True, "data": data})

    async def h_access_log_save(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        time_text = str(body.get("time") or "").strip()
        device = str(body.get("device") or "").strip()
        ip = self.detect_client_ip(request)
        code = str(body.get("code") or "").strip()
        op = str(body.get("op") or "-").strip() or "-"
        if not time_text or not code:
            return json_response({"ok": False, "error": "time and code are required"}, 400)
        res = await db.prepare("INSERT INTO access_logs(time, device, ip, code, op) VALUES(?, ?, ?, ?, ?)").bind(
            time_text, device, ip, code, op
        ).run()
        log_id = res.meta["last_row_id"]
        await db.prepare(
            "DELETE FROM access_logs WHERE id NOT IN (SELECT id FROM access_logs ORDER BY id DESC LIMIT 100)"
        ).run()
        return json_response({"ok": True, "id": log_id, "ip": ip, "device": device})

    async def h_access_log_delete(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        ids = body.get("ids")
        if not isinstance(ids, list) or len(ids) == 0:
            return json_response({"ok": False, "error": "ids array is required"}, 400)
        try:
            clean_ids = [int(x) for x in ids]
        except Exception:
            return json_response({"ok": False, "error": "ids must be integers"}, 400)
        placeholders = ",".join("?" for _ in clean_ids)
        res = await db.prepare(f"DELETE FROM access_logs WHERE id IN ({placeholders})").bind(*clean_ids).run()
        return json_response({"ok": True, "deleted": res.meta.get("changes", 0)})

    async def h_access_log_delete_all(self, db):
        res = await db.prepare("DELETE FROM access_logs").run()
        return json_response({"ok": True, "deleted": res.meta.get("changes", 0)})

    def detect_client_ip(self, request) -> str:
        candidates = []
        for key in ("CF-Connecting-IP", "X-Forwarded-For", "X-Real-IP"):
            raw = str(request.headers.get(key, "") or "").strip()
            if not raw:
                continue
            if key == "X-Forwarded-For":
                raw = raw.split(",", 1)[0].strip()
            if raw:
                candidates.append(raw)
        for value in candidates:
            if value == "::1":
                return "127.0.0.1"
            ip = ipv4_only(value)
            if ip:
                return ip
        return "Unknown"

    # ---- prefs ----
    async def h_prefs_load(self, db, parsed):
        key = str(parse_qs(parsed.query).get("key", [""])[0] or "").strip()
        if key:
            row = await db.prepare("SELECT data, updated FROM app_prefs WHERE key = ?").bind(key).first()
            data, updated = {}, ""
            if row and row.get("data"):
                try:
                    data = json.loads(row["data"])
                except Exception:
                    data = {}
                updated = str(row.get("updated") or "")
            if not isinstance(data, dict):
                data = {}
            return json_response({"ok": True, "key": key, "data": data, "updated": updated})
        res = await db.prepare("SELECT key, data, updated FROM app_prefs ORDER BY key").all()
        prefs = {}
        for r in res.results:
            try:
                payload = json.loads(r["data"]) if r.get("data") else {}
            except Exception:
                payload = {}
            prefs[str(r.get("key") or "")] = {"data": payload if isinstance(payload, dict) else {}, "updated": str(r.get("updated") or "")}
        return json_response({"ok": True, "prefs": prefs})

    async def h_prefs_save(self, db, request):
        body = await request.json()
        if not isinstance(body, dict):
            return json_response({"ok": False, "error": "invalid JSON body"}, 400)
        key = str(body.get("key") or "").strip()
        if not key:
            return json_response({"ok": False, "error": "key is required"}, 400)
        data = body.get("data")
        if data is None:
            data = {}
        if not isinstance(data, dict):
            return json_response({"ok": False, "error": "data must be an object"}, 400)
        updated = now_iso()
        await db.prepare(
            "INSERT INTO app_prefs(key, data, updated) VALUES(?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated"
        ).bind(key, json.dumps(data, ensure_ascii=False), updated).run()
        return json_response({"ok": True, "key": key, "updated": updated})