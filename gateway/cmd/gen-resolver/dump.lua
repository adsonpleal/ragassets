-- dump.lua — runs inside a 32-bit lua5.1 (so it can load the client's 32-bit
-- .lub bytecode) and dumps the resolver lookup tables to TSV files under /out.
--
-- Names are EUC-KR (Windows-949) bytes, hex-encoded so they survive TSV; the Go
-- generator decodes them to UTF-8. Mirrors the set of files zrenderer loads in
-- luamanager.loadRequiredLuaFiles and the functions it calls in resolver.d.
--
-- Usage (see generate.sh): lua5.1 dump.lua <luafiles_datainfo_dir> <offsetitempos_dir> <out_dir>

local datadir = assert(arg[1], "datainfo dir required")
local offsetdir = assert(arg[2], "offsetitempos dir required")
local outdir = assert(arg[3], "out dir required")

local function tryload(dir, name)
  local f, err = loadfile(dir .. "/" .. name .. ".lub")
  if not f then
    io.stderr:write("skip " .. name .. ": " .. tostring(err) .. "\n")
    return false
  end
  local ok, e = pcall(f)
  if not ok then
    io.stderr:write("exec fail " .. name .. ": " .. tostring(e) .. "\n")
    return false
  end
  return true
end

-- Load order mirrors zrenderer's luamanager.
for _, n in ipairs({
  "accessoryid", "accname", "accname_f",
  "spriterobeid", "spriterobename", "spriterobename_f",
  "weapontable", "weapontable_f",
  "npcidentity", "jobidentity", "jobname", "jobname_f",
  "shadowtable", "shadowtable_f",
}) do
  tryload(datadir, n)
end
tryload(offsetdir, "offsetitempos")
tryload(offsetdir, "offsetitempos_f")

local function hex(s)
  if type(s) ~= "string" then return "" end
  return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

local function open(name) return assert(io.open(outdir .. "/" .. name, "w")) end

local function callstr(fn, ...)
  if type(_G[fn]) ~= "function" then return nil end
  local ok, v = pcall(_G[fn], ...)
  if ok and type(v) == "string" and #v > 0 then return v end
  return nil
end

-- Report which functions are available.
local avail = open("available.txt")
for _, fn in ipairs({"ReqAccName", "ReqRobSprName_V2", "ReqWeaponName", "GetRealWeaponId",
                     "ReqJobName", "IsTopLayer", "_New_DrawOnTop", "ReqshadowFactor",
                     "OffsetItemPos_GetOffsetForDoram"}) do
  avail:write(fn .. "\t" .. type(_G[fn]) .. "\n")
end
avail:close()

-- ReqAccName(id) -> accessory name.
do
  local f = open("accname.tsv")
  for id = 1, 50000 do
    local v = callstr("ReqAccName", id)
    if v then f:write(id .. "\t" .. hex(v) .. "\n") end
  end
  f:close()
end

-- ReqRobSprName_V2(id, checkEnglish) -> garment name (both variants).
do
  local f = open("robe.tsv")
  for id = 1, 10000 do
    for _, eng in ipairs({false, true}) do
      local v = callstr("ReqRobSprName_V2", id, eng)
      if v then f:write(id .. "\t" .. tostring(eng) .. "\t" .. hex(v) .. "\n") end
    end
  end
  f:close()
end

-- ReqWeaponName(id) and GetRealWeaponId(id).
do
  local f = open("weapon.tsv")
  for id = 1, 30000 do
    local v = callstr("ReqWeaponName", id)
    if v then f:write(id .. "\t" .. hex(v) .. "\n") end
  end
  f:close()
  local rf = open("realweapon.tsv")
  if type(GetRealWeaponId) == "function" then
    for id = 1, 30000 do
      local ok, r = pcall(GetRealWeaponId, id)
      if ok and type(r) == "number" and r ~= id and r > 0 then
        rf:write(id .. "\t" .. math.floor(r) .. "\n")
      end
    end
  end
  rf:close()
end

-- ReqJobName(id) -> non-player sprite name.
do
  local f = open("jobname.tsv")
  for id = 45, 40000 do
    local v = callstr("ReqJobName", id)
    if v then f:write(id .. "\t" .. hex(v) .. "\n") end
  end
  f:close()
end

-- IsTopLayer(garmentid) -> bool.
do
  local f = open("istoplayer.tsv")
  if type(IsTopLayer) == "function" then
    for id = 1, 10000 do
      local ok, v = pcall(IsTopLayer, id)
      if ok and v then f:write(id .. "\ttrue\n") end
    end
  end
  f:close()
end

-- ReqshadowFactor(jobid) -> float (only non-1 values matter).
do
  local f = open("shadowfactor.tsv")
  if type(ReqshadowFactor) == "function" then
    for id = 0, 40000 do
      local ok, v = pcall(ReqshadowFactor, id)
      if ok and type(v) == "number" and v ~= 1 then
        f:write(id .. "\t" .. tostring(v) .. "\n")
      end
    end
  end
  f:close()
end

-- OffsetItemPos_GetOffsetForDoram(headgear, direction, gender) -> x,y.
do
  local f = open("doramoffset.tsv")
  if type(OffsetItemPos_GetOffsetForDoram) == "function" then
    for id = 1, 50000 do
      for dir = 0, 7 do
        for g = 0, 1 do
          local ok, x, y = pcall(OffsetItemPos_GetOffsetForDoram, id, dir, g)
          if ok and (type(x) == "number" or type(y) == "number") then
            local xi = math.floor(tonumber(x) or 0)
            local yi = math.floor(tonumber(y) or 0)
            if xi ~= 0 or yi ~= 0 then
              f:write(id .. "\t" .. dir .. "\t" .. g .. "\t" .. xi .. "\t" .. yi .. "\n")
            end
          end
        end
      end
    end
  end
  f:close()
end

-- Probe _New_DrawOnTop dependence: vary each argument for a few garments.
do
  local f = open("drawontop_probe.tsv")
  if type(_New_DrawOnTop) == "function" then
    local function call(gid, gender, job, action, frame)
      local ok, v = pcall(_New_DrawOnTop, gid, gender, job, action, frame)
      if ok then return v and 1 or 0 else return "?" end
    end
    for _, gid in ipairs({1, 2, 3, 100, 200, 500}) do
      f:write("gid=" .. gid ..
        " base=" .. call(gid, 1, 1, 0, 0) ..
        " g0=" .. call(gid, 0, 1, 0, 0) ..
        " job7=" .. call(gid, 1, 7, 0, 0) ..
        " act16=" .. call(gid, 1, 1, 16, 0) ..
        " frame2=" .. call(gid, 1, 1, 0, 2) .. "\n")
    end
  end
  f:close()
end

print("dump complete")
