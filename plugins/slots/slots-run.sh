#!/bin/sh
# Run a foreground command under a renewable Machine Slots use.
interval=${SLOTS_RUN_TEST_STEP:-1}
dir=$(mktemp -d "${TMPDIR:-/tmp}/slots-run.XXXXXX") || exit 70
use= loop= cleaned=
cleanup() {
  [ -n "$cleaned" ] && return
  cleaned=1
  if [ -n "$loop" ]; then
    : > "$dir/stop"
    n=0
    while kill -0 "$loop" 2>/dev/null && [ "$n" -lt 5 ]; do sleep "$interval"; n=$((n + 1)); done
    if kill -0 "$loop" 2>/dev/null; then kill -KILL "$loop" 2>/dev/null; fi
    wait "$loop" 2>/dev/null
  fi
  if [ -n "$use" ]; then
    bb slots done "$use" >/dev/null 2>&1 & dp=$!
    n=0
    while kill -0 "$dp" 2>/dev/null && [ "$n" -lt 10 ]; do sleep "$interval"; n=$((n + 1)); done
    if kill -0 "$dp" 2>/dev/null; then kill -KILL "$dp" 2>/dev/null; fi
    wait "$dp" 2>/dev/null
  fi
  rm -rf "$dir"
}
# Perl for the other machine, one script with several modes. It travels as an argument, so it holds no single quote.
PL='
use strict; use warnings; use Digest::SHA; use Fcntl qw(:flock);
my $mode = shift @ARGV;
if ($mode eq "lock") {
  open(my $f, ">&=", 9) or die "fd 9: $!\n";
  flock($f, LOCK_EX) or die "flock: $!\n";
  exit 0;
}
if ($mode eq "exec") {
  setpgrp(0, 0);
  $SIG{INT} = "DEFAULT"; $SIG{QUIT} = "DEFAULT";
  { no warnings; exec { $ARGV[0] } @ARGV; }
  print STDERR "slots-run: cannot run $ARGV[0]: $!\n"; exit 127;
}
sub walk {
  my ($root, $cb) = @_;
  my $rec; $rec = sub {
    my ($rel) = @_;
    my $dir = length $rel ? "$root/$rel" : $root;
    opendir(my $h, $dir) or return;
    my @n = sort grep { $_ ne "." && $_ ne ".." && $_ ne ".git" && $_ ne "node_modules" } readdir $h;
    closedir $h;
    for my $n (@n) {
      my $r = length $rel ? "$rel/$n" : $n;
      my $p = "$root/$r";
      if (-l $p) { $cb->($r, "l") }
      elsif (-d _) { $rec->($r); $cb->($r, "d") }
      elsif (-f _) { $cb->($r, "f") }
    }
  };
  $rec->("");
}
sub ent {
  my ($p, $t) = @_;
  if ($t eq "l") { my $l = readlink($p); return ("l", defined $l ? $l : "?") }
  my $h = eval { my $d = Digest::SHA->new(256); $d->addfile($p, "b"); $d->hexdigest };
  return ("f", defined $h ? $h : "?");
}
my ($m, $a2, $a3, $a4) = @ARGV;
if ($mode eq "snap") {
  open(my $o, ">", $a2) or die "$a2: $!\n"; binmode $o;
  walk($m, sub { my ($r, $t) = @_; return if $t eq "d"; my ($ty, $h) = ent("$m/$r", $t); print $o "$ty\0$h\0$r\0" });
  close $o or die "$a2: $!\n"; exit 0;
}
if ($mode eq "clean") {
  open(my $i, "<", $a2) or die "$a2: $!\n"; my %keep; while (<$i>) { chomp; $keep{$_} = 1 } close $i;
  walk($m, sub { my ($r, $t) = @_; if ($t eq "d") { rmdir "$m/$r" } elsif (!$keep{$r}) { unlink "$m/$r" } });
  exit 0;
}
if ($mode eq "diff") {
  my ($ret, $max) = ($a3, $a4);
  my %old; open(my $i, "<", $a2) or die "$a2: $!\n"; binmode $i;
  { local $/ = "\0"; while (defined(my $ty = <$i>)) { my $h = <$i>; my $r = <$i>; last unless defined $r; chomp $ty; chomp $h; chomp $r; $old{$r} = [$ty, $h] } }
  close $i;
  my (@chg, %seen); my ($bytes, $dirty) = (0, 0);
  walk($m, sub { my ($r, $t) = @_; return if $t eq "d"; $seen{$r} = 1; my ($ty, $h) = ent("$m/$r", $t); my $o = $old{$r};
    if (!$o) { push @chg, $r } elsif ($o->[0] ne $ty || $o->[1] ne $h) { push @chg, $r; $dirty = 1 } });
  my @del = sort grep { !$seen{$_} } keys %old; $dirty = 1 if @del;
  my $dl = join("", map { "$_\0" } @del);
  for my $r (@chg) { my @s = lstat("$m/$r"); $bytes += $s[7] if @s && -f _ }
  $bytes += length $dl;
  my $status = (!@chg && !@del) ? "none" : $bytes > $max ? "skipped" : "changed";
  if ($status eq "changed") {
    open(my $l, ">", "$ret.list") or die "$ret.list: $!\n"; binmode $l; print $l map { "$_\0" } @chg; close $l or die;
    open(my $d, ">", "$ret.delraw") or die "$ret.delraw: $!\n"; binmode $d; print $d $dl; close $d or die;
  }
  open(my $n, ">", "$ret.info") or die "$ret.info: $!\n";
  print $n "status=$status\ncount=" . scalar(@chg) . "\nbytes=$bytes\ndirty=$dirty\n"; close $n or die;
  exit 0;
}
die "unknown mode $mode\n";
'
# Runs on the other machine: lock the mirror for the whole run, refresh it, install dependencies when a lockfile changed,
# run the command as a child, then pack what it wrote. The mirror holds only uploaded files when the command starts,
# so every other file afterwards, and every uploaded file whose content changed, came from the command.
RUNNER='
key=$1 rel=$2 hash=$3 upload=$4 nonce=$5 retmax=$6 pl=$7 gitmode=$8; shift 8
base=$HOME/.bb-slots/work m=$HOME/.bb-slots/work/$key ret=${upload%.b64}.ret
perl=/usr/bin/perl; [ -x "$perl" ] || perl=$(command -v perl)
legacy=
cleanup_mirror() {
  [ -n "$legacy" ] || return
  if [ -n "$gitmode" ]; then rm -rf "$m/.git"; fi
  rm -f "$m.lock/flock-owner"; rmdir "$m.lock" 2>/dev/null
}
trap cleanup_mirror EXIT
fail() { rm -f "$upload" "$m.tgz"; echo "slots-run: $1" >&2; echo "slots-run setup-failed $nonce"; exit 69; }
mkdir -p "$m" || fail "cannot create $m"
# A kernel lock on fd 9 serializes runs on this mirror. It is dropped when this shell exits, whatever the cause.
exec 9>>"$m.flock"
"$perl" -e "$pl" lock || fail "could not lock the mirror $m (is perl installed?)"
# Runners of older versions know only this directory lock. Hold it too, so they never refresh the mirror under this run.
n=0
while ! mkdir "$m.lock" 2>/dev/null; do
  # A lock with this marker belongs to a runner of this version that died; we hold the flock, so no such runner is alive.
  if [ -e "$m.lock/flock-owner" ]; then rm -f "$m.lock/flock-owner"; rmdir "$m.lock" 2>/dev/null || sleep 1; continue; fi
  n=$((n + 1))
  [ "$n" -lt 600 ] || { echo "slots-run: mirror $m is locked; remove $m.lock if no run is active" >&2; rm -f "$upload"; echo "slots-run setup-failed $nonce"; exit 69; }
  sleep 1
done
: >"$m.lock/flock-owner"; legacy=1
trap "fail \"stopped while preparing the mirror\"" HUP INT TERM
# An unchanged worktree is not unpacked again.
if [ -n "$gitmode" ] || [ "$(cat "$m.hash" 2>/dev/null)" != "$hash" ] || [ ! -f "$m.manifest" ]; then
  rm -f "$m.hash"
  if [ -n "$gitmode" ]; then
    rm -rf "$m/.git" || fail "could not reset Git metadata"
    base64 -d <"$upload" >"$m.tgz" && tar tzf "$m.tgz" >"$m.new.raw" &&
      sed -e "/^\.git$/d" -e "\|^\.git/|d" "$m.new.raw" | sort >"$m.new" || fail "could not read the Git snapshot"
    rm -f "$m.new.raw"
    tar xzf "$m.tgz" -C "$m" || fail "could not unpack the Git snapshot"
  else
    base64 -d <"$upload" >"$m.tgz" && tar tzf "$m.tgz" | sort >"$m.new" && tar xzf "$m.tgz" -C "$m" || fail "could not unpack the worktree"
  fi
  if [ -f "$m.manifest" ]; then comm -23 "$m.manifest" "$m.new" | while IFS= read -r f; do rm -f "$m/$f"; done; fi
  mv "$m.new" "$m.manifest"; rm -f "$m.tgz"
  d=$rel
  while :; do
    for f in package-lock.json bun.lock bun.lockb; do
      [ -f "$m/$d/$f" ] || continue
      sum=$(shasum "$m/$d/$f" | cut -c1-40)
      if [ "$(cat "$m/$d/node_modules/.bb-slots-lock" 2>/dev/null)" != "$sum" ]; then
        echo "slots-run: installing dependencies in $d" >&2
        case $f in
          package-lock.json) (cd "$m/$d" && npm ci --no-audit --no-fund </dev/null 9>&- >&2) ;;
          *) (cd "$m/$d" && bun install --frozen-lockfile </dev/null 9>&- >&2) ;;
        esac || fail "dependency install failed in $d"
        printf %s "$sum" >"$m/$d/node_modules/.bb-slots-lock"
      fi
      break
    done
    [ "$d" = . ] && break
    d=$(dirname "$d")
  done
  printf %s "$hash" >"$m.hash"
fi
trap - HUP INT TERM
rm -f "$upload"; touch "$m"
find "$base" -mindepth 1 -maxdepth 1 -mtime +7 ! -name "*.flock" ! -name "*.lock" ! -name "$key*" -exec rm -rf {} + 2>/dev/null
find "$(dirname "$upload")" -maxdepth 1 -name "bb-slots-*.ret.*" -mtime +1 -exec rm -rf {} + 2>/dev/null
"$perl" -e "$pl" clean "$m" "$m.manifest" && "$perl" -e "$pl" snap "$m" "$m.snap" || fail "could not index the mirror"
if [ -n "$gitmode" ]; then
  actual=$(git -C "$m" rev-list --parents -n 1 HEAD) &&
    [ "$actual" = "$(cat "$m/.git/slots-head")" ] &&
    git -C "$m" --no-optional-locks status --porcelain -z >"$m/.git/slots-actual" &&
    cmp -s "$m/.git/slots-actual" "$m/.git/slots-status" || fail "Git HEAD, parents or status differ from the local snapshot"
  rm -f "$m/.git/slots-head" "$m/.git/slots-actual" "$m/.git/slots-status"
fi
mkdir -p "$m/$rel" && cd "$m/$rel" || { echo "slots-run setup-failed $nonce"; exit 69; }
# The mirror may stop matching its hash while the command runs; the hash comes back only if no uploaded file changed.
rm -f "$m.hash"
cmdpid=
fwd() { kill -s "$1" -- "-$cmdpid" 2>/dev/null || kill -s "$1" "$cmdpid" 2>/dev/null; }
trap "fwd HUP" HUP; trap "fwd INT" INT; trap "fwd TERM" TERM
"$perl" -e "$pl" exec "$@" </dev/null 9>&- &
cmdpid=$!
wait "$cmdpid"; rc=$?
while kill -0 "$cmdpid" 2>/dev/null; do wait "$cmdpid"; rc=$?; done
trap - HUP INT TERM
status=failed count=0 bytes=0 parts=0 dirty=1 del=0
if "$perl" -e "$pl" diff "$m" "$m.snap" "$ret" "$retmax" 2>/dev/null; then
  status=$(sed -n "s/^status=//p" "$ret.info"); count=$(sed -n "s/^count=//p" "$ret.info")
  bytes=$(sed -n "s/^bytes=//p" "$ret.info"); dirty=$(sed -n "s/^dirty=//p" "$ret.info")
  if [ "$status" = changed ]; then
    status=failed
    # The deletion list travels as its own file, outside the path space of the archive, so no worktree file can collide with it.
    if { [ ! -s "$ret.list" ] || { (cd "$m" && COPYFILE_DISABLE=1 tar --format=pax -cf "$ret.tar" --null -T "$ret.list") 2>/dev/null \
        && gzip -c "$ret.tar" >"$ret.tgz" && split -b 15000000 "$ret.tgz" "$ret.p."; }; } \
      && { [ ! -s "$ret.delraw" ] || { base64 <"$ret.delraw" >"$ret.del" && del=1; }; }; then
      parts=0 status=packed
      for f in "$ret".p.*; do
        [ -e "$f" ] || continue
        parts=$((parts + 1))
        base64 <"$f" >"$ret.$parts" || status=failed
      done
    fi
    [ "$status" = packed ] || { rm -f "$ret".[0-9]* "$ret.del"; del=0; }
  fi
fi
rm -rf "$ret.info" "$ret.list" "$ret.delraw" "$ret.tar" "$ret.tgz" "$ret".p.*
printf "nonce=%s\nstatus=%s\ncount=%s\nbytes=%s\nparts=%s\ndel=%s\n" "$nonce" "$status" "$count" "$bytes" "$parts" "$del" >"$ret.meta.tmp" && mv "$ret.meta.tmp" "$ret.meta"
[ "$dirty" = 0 ] && printf %s "$hash" >"$m.hash"
exit "$rc"
'
# Local side: what every path that may come back looked like before the run (type, content hash or link target).
BASE_JS='
const fs=require("fs"),cr=require("crypto"),path=require("path");
const [root,files,ign,out,cap]=process.argv.slice(1);
const skip=p=>p.split("/").some(s=>s==="node_modules"||s===".git");
const hashFile=p=>{const h=cr.createHash("sha256"),fd=fs.openSync(p,"r"),b=Buffer.alloc(1<<20);try{for(let n;(n=fs.readSync(fd,b,0,b.length,null))>0;)h.update(b.subarray(0,n))}finally{fs.closeSync(fd)}return h.digest("hex")};
const stat=rel=>{try{return fs.lstatSync(path.join(root,rel))}catch{return null}};
const mk=(rel,st,hash)=>{const p=path.join(root,rel);if(st.isSymbolicLink())return["l",fs.readlinkSync(p)];if(!st.isFile())return null;try{return["f",hash?hashFile(p):null]}catch{return["f",null]}};
const res=Object.create(null);
for(const rel of fs.readFileSync(files,"utf8").split("\n").filter(Boolean)){const st=stat(rel);const e=st&&mk(rel,st,true);if(e)res[rel]=e}
const ig=fs.readFileSync(ign,"utf8").split("\0").filter(r=>r&&!skip(r)&&!(r in res));
const sts=ig.map(stat);let total=0;for(const st of sts)if(st&&st.isFile())total+=st.size;
const hash=total<=Number(cap);
ig.forEach((rel,i)=>{const e=sts[i]&&mk(rel,sts[i],hash);if(e)res[rel]=e});
fs.writeFileSync(out,JSON.stringify(res));
'
# Local side: check the returned archive completely, then apply it without overwriting anything changed here during the run.
APPLY_JS='
const fs=require("fs"),cr=require("crypto"),zlib=require("zlib"),cp=require("child_process"),path=require("path");
const [rootArg,baseF,filesF,delF,countS,bytesS,machine,mirror,...parts]=process.argv.slice(1);
const clean=s=>String(s).replace(/[\u0000-\u001f\u007f]/g,"?");
const list=a=>(a.length>20?a.slice(0,20).map(clean).join(", ")+" and "+(a.length-20)+" more":a.map(clean).join(", "));
const bad=m=>{console.error("slots-run: rejected the files from "+machine+": "+m+"; nothing was written");process.exit(3)};
const root=fs.realpathSync(rootArg);
const base=new Map(Object.entries(JSON.parse(fs.readFileSync(baseF,"utf8"))));
// Only files that were uploaded can be deleted by the other machine; the baseline also lists ignored files, so it cannot vouch for a deletion.
const uploaded=new Set(fs.readFileSync(filesF,"utf8").split("\n").filter(Boolean));
const count=Number(countS),bytes=Number(bytesS);
let buf;
try{buf=!parts.length?Buffer.alloc(0):zlib.gunzipSync(Buffer.concat(parts.map(f=>Buffer.from(fs.readFileSync(f,"latin1"),"base64"))),{maxOutputLength:bytes+(count+1)*8192+20480})}catch(e){bad("unreadable archive ("+e.message+")")}
const str=(b,s,l)=>{let e=s;while(e<s+l&&b[e]!==0)e++;return b.toString("utf8",s,e)};
const oct=(b,s,l)=>{if(b[s]&0x80)bad("unsupported size field");const t=b.toString("ascii",s,s+l).replace(/\0.*$/s,"").trim();return t?parseInt(t,8):0};
const okPath=p=>typeof p==="string"&&p!==""&&!p.includes("\0")&&!p.startsWith("/")&&p.split("/").every(s=>s!==""&&s!=="."&&s!==".."&&s!==".git"&&s!=="node_modules");
const entries=new Map();let deleted=[],off=0,pax=null,total=0;
while(off+512<=buf.length){
  const h=buf.subarray(off,off+512);
  if(h.every(x=>x===0))break;
  let sum=0;for(let i=0;i<512;i++)sum+=(i>=148&&i<156)?32:h[i];
  if(sum!==oct(h,148,8))bad("bad tar header");
  const type=String.fromCharCode(h[156]||48);
  let size=oct(h,124,12);
  let name=str(h,0,100);
  if(h.toString("ascii",257,262)==="ustar"){const pre=str(h,345,155);if(pre)name=pre+"/"+name}
  let link=str(h,157,100);
  const mode=oct(h,100,8);
  off+=512;
  if(type==="x"){
    const d=buf.subarray(off,off+size);pax={};let p=0;
    while(p<d.length){const sp=d.indexOf(32,p);const len=Number(d.toString("ascii",p,sp));if(!(len>0)||p+len>d.length)bad("bad pax record");const rec=d.toString("utf8",sp+1,p+len-1);const eq=rec.indexOf("=");pax[rec.slice(0,eq)]=rec.slice(eq+1);p+=len}
    off+=Math.ceil(size/512)*512;continue;
  }
  if(pax){if(pax.path!=null)name=pax.path;if(pax.linkpath!=null)link=pax.linkpath;if(pax.size!=null)size=Number(pax.size);pax=null}
  if(off+size>buf.length)bad("truncated archive");
  const data=buf.subarray(off,off+size);off+=Math.ceil(size/512)*512;
  if(type!=="0"&&type!=="2")bad("unsupported entry type "+type+" for "+clean(name));
  if(!okPath(name))bad("unsafe path "+clean(name));
  if(entries.has(name))bad("duplicate path "+clean(name));
  if(type==="2"&&!link)bad("empty link target for "+clean(name));
  if(type==="0")total+=size;
  entries.set(name,type==="2"?{kind:"l",link}:{kind:"f",data,mode:mode&0o777});
}
deleted=Buffer.from(fs.readFileSync(delF,"latin1"),"base64").toString("utf8").split("\0").filter(Boolean);
if(entries.size>count)bad("more entries than announced");
if(total>bytes)bad("more data than announced");
for(const p of deleted){if(!okPath(p)||entries.has(p))bad("unsafe deleted path "+clean(p));if(!uploaded.has(p))bad("deleted path was never uploaded: "+clean(p))}
for(const p of entries.keys()){const segs=p.split("/");for(let i=1;i<segs.length;i++)if(entries.has(segs.slice(0,i).join("/")))bad("entry below another entry: "+clean(p))}
const hashOf=p=>{const h=cr.createHash("sha256"),fd=fs.openSync(p,"r"),b=Buffer.alloc(1<<20);try{for(let n;(n=fs.readSync(fd,b,0,b.length,null))>0;)h.update(b.subarray(0,n))}finally{fs.closeSync(fd)}return h.digest("hex")};
const cur=abs=>{try{const st=fs.lstatSync(abs);if(st.isSymbolicLink())return["l",fs.readlinkSync(abs)];if(st.isFile())return["f",hashOf(abs)];return["d"]}catch(e){if(e.code==="ENOENT"||e.code==="ENOTDIR")return null;throw e}};
const parents=(rel,create)=>{let c=root;for(const s of rel.split("/").slice(0,-1)){c=path.join(c,s);let st;try{st=fs.lstatSync(c)}catch(e){if(e.code!=="ENOENT")return"file";if(!create)return"ok";fs.mkdirSync(c);continue}if(st.isSymbolicLink())return"link";if(!st.isDirectory())return"file"}return"ok"};
const same=(a,b)=>a&&b&&a[0]===b[0]&&a[1]===b[1];
// A returned path is written only if nothing there changed since the baseline; a path missing at both times counts as unchanged.
const free=(rel,abs)=>{const b=base.get(rel);const c=cur(abs);return b===undefined?c===null:(b[1]!==null&&same(c,b))};
const written=[],kept=[],skipped=[],skippedDel=[],trashed=[],saved=[];
const tag=()=>".slots-run-"+cr.randomBytes(6).toString("hex");
// Test seams: a shell command from SLOTS_RUN_TEST_AT_<point> runs at that point, SLOTS_RUN_TEST_NOLINK pretends hard links are unsupported, SLOTS_RUN_TEST_THROW=hash|unlink|delhash|write fails the last aside step, the hash of a file moved for deletion, or the write of a new file.
const hook=(n,env)=>{const c=process.env["SLOTS_RUN_TEST_AT_"+n];if(c)try{cp.execSync(c,{stdio:"ignore",env:{...process.env,...env}})}catch{}};
const left=(rel,aside,label)=>saved.push(rel+" (yours is "+(label||path.basename(aside))+")");
// Puts a moved-aside original back without ever replacing something that appeared at its place meanwhile; whatever cannot be put back stays beside it.
function restore(rel,abs,aside,label){
  try{
    const st=fs.lstatSync(aside);
    if(st.isSymbolicLink())fs.symlinkSync(fs.readlinkSync(aside),abs);
    else if(st.isDirectory()){
      // shortcut: node has no no-replace rename, so a directory created between this check and the rename would be replaced if it is empty
      try{fs.lstatSync(abs);throw new Error("destination exists")}catch(err){if(err.code!=="ENOENT")throw err}
      fs.renameSync(aside,abs);return;
    }
    else if(st.isFile()){
      try{fs.linkSync(aside,abs)}catch(err){
        if(err.code==="EEXIST")throw err;
        fs.copyFileSync(aside,abs,fs.constants.COPYFILE_EXCL);
        if(hashOf(aside)!==hashOf(abs))throw new Error("changed while copying");
      }
    }else throw new Error("not restorable");
    fs.unlinkSync(aside);
  }catch{left(rel,aside,label)}
}
// The destination is replaced last, and only after it was moved aside and found equal to the baseline, so a local edit made at any
// moment of a long write is kept. Every step that puts something at the destination refuses to replace: a file that appeared meanwhile is kept.
function install(rel,abs,e){
  const dir=path.dirname(abs),tmp=path.join(dir,tag()),aside=path.join(dir,tag()),b=base.get(rel);
  let moved=false,res="kept";
  try{
    if(e.kind==="f"){if(process.env.SLOTS_RUN_TEST_THROW==="write")throw new Error("injected");fs.writeFileSync(tmp,e.data,{flag:"wx"});fs.chmodSync(tmp,e.mode)}
    hook("tmp",{ASIDE:aside});
    try{fs.renameSync(abs,aside);moved=true}catch(err){if(err.code!=="ENOENT")throw err}
    const ok=moved?(b!==undefined&&b[1]!==null&&same(cur(aside),b)):b===undefined;
    hook("place",{ASIDE:aside});
    if(!ok){if(moved){moved=false;restore(rel,abs,aside)}return "kept"}
    try{
      if(e.kind==="l")fs.symlinkSync(e.link,abs);
      else{
        try{if(process.env.SLOTS_RUN_TEST_NOLINK)throw Object.assign(new Error("no hard links"),{code:"EPERM"});fs.linkSync(tmp,abs)}
        catch(err){if(err.code==="EEXIST")throw err;fs.copyFileSync(tmp,abs,fs.constants.COPYFILE_EXCL);fs.chmodSync(abs,e.mode)}
      }
      res="written";
    }catch(err){
      if(err.code!=="EEXIST")throw err;
      if(moved){moved=false;left(rel,aside)} // someone created the destination: keep theirs and the original
      return "kept";
    }
    hook("placed",{ASIDE:aside});
    if(moved){
      // The aside stays ours until it is gone; any failure reports it.
      try{
        if(process.env.SLOTS_RUN_TEST_THROW==="hash")throw new Error("injected");
        if(same(cur(aside),b)){
          if(process.env.SLOTS_RUN_TEST_THROW==="unlink")throw new Error("injected");
          // shortcut: a process that wrote through an old descriptor between this check and the unlink loses that write; detect and keep covers the rest
          fs.unlinkSync(aside);
        }else left(rel,aside);
      }catch{left(rel,aside)}
      moved=false;
    }
    return res;
  }catch{return "skipped"}
  finally{
    try{fs.unlinkSync(tmp)}catch{}
    if(moved)restore(rel,abs,aside);
  }
}
for(const [rel,e] of entries){
  const abs=path.join(root,rel);
  try{
    const ps=parents(rel,false);
    if(ps==="link"){skipped.push(rel);continue}
    if(ps==="file"||!free(rel,abs)){kept.push(rel);continue}
    if(parents(rel,true)!=="ok"){skipped.push(rel);continue}
    if(!free(rel,abs)){kept.push(rel);continue}
    const r=install(rel,abs,e);
    (r==="written"?written:r==="skipped"?skipped:kept).push(rel);
  }catch{skipped.push(rel)}
}
for(const rel of deleted){
  const abs=path.join(root,rel);
  try{
    if(parents(rel,false)!=="ok"){skippedDel.push(rel);continue}
    const b=base.get(rel);
    if(!b||b[1]===null||!same(cur(abs),b)){kept.push(rel);continue}
    // The file is moved into its own fresh directory first and checked there, so an edit made after the check above is never trashed.
    const dir=path.join(path.dirname(abs),tag()),mv=path.join(dir,path.basename(abs)),label=path.basename(dir)+"/"+path.basename(abs);
    let owned=false; // true from the rename until the file is trashed or put back: any failure in between restores it or reports its path
    const giveBack=()=>{owned=false;hook("delplace",{FILE:abs});restore(rel,abs,mv,label)};
    try{
      fs.mkdirSync(dir);
      hook("delmove",{FILE:abs});
      try{fs.renameSync(abs,mv);owned=true}catch(err){if(err.code==="ENOENT"){kept.push(rel);continue}throw err}
      if(process.env.SLOTS_RUN_TEST_THROW==="delhash")throw new Error("injected");
      if(!same(cur(mv),b)){giveBack();kept.push(rel);continue}
      // shortcut: a write through a descriptor opened earlier that lands after this hash goes to the Trash with the file, where it is recoverable
      try{cp.execFileSync(process.env.SLOTS_RUN_TRASH||"/usr/bin/trash",[mv],{stdio:"ignore"});owned=false;trashed.push(rel)}
      catch{giveBack();skippedDel.push(rel)}
    }catch{if(owned)giveBack();skippedDel.push(rel)}
    finally{try{fs.rmdirSync(dir)}catch{}}
  }catch{skippedDel.push(rel)}
}
const out=[];
if(written.length)out.push("brought back "+written.length+" file"+(written.length===1?"":"s")+" from "+machine);
if(kept.length)out.push("kept your local version of: "+list(kept));
// Outputs that could not be written here are still in the mirror on the other machine until the next run from this worktree cleans it.
if(skipped.length)out.push("not applied: "+list(skipped)+" (the new content stays on "+machine+" in "+mirror+" until the next run from this worktree)");
if(skippedDel.length)out.push("not applied: "+list(skippedDel)+" (deletion not done here)");
if(trashed.length)out.push("moved to Trash: "+list(trashed));
if(saved.length)out.push("your changed copy was left beside the original of: "+list(saved));
if(out.length)console.error("slots-run: "+out.join("; "));
'
# After a remote run: read the result files the runner left, check them, and apply them here.
bring_back() {
  ret=${upload%.b64}.ret
  if ! bb file read --host "$host" "$ret.meta" >"$dir/meta" 2>/dev/null || [ "$(sed -n 's/^nonce=//p' "$dir/meta")" != "$nonce" ]; then
    echo "slots-run: files written on ${name:-$host} may not have come back; look in ~/.bb-slots/work/$key there" >&2; return
  fi
  rstatus=$(sed -n 's/^status=//p' "$dir/meta"); rcount=$(sed -n 's/^count=//p' "$dir/meta")
  rbytes=$(sed -n 's/^bytes=//p' "$dir/meta"); rparts=$(sed -n 's/^parts=//p' "$dir/meta"); rdel=$(sed -n 's/^del=//p' "$dir/meta")
  : >"$dir/del"
  keep=
  case $rstatus in
    none) ;;
    skipped) echo "slots-run: files written on ${name:-$host} were not brought back: $rbytes bytes is over SLOTS_RUN_RETURN_MAX; they stay in ~/.bb-slots/work/$key there" >&2 ;;
    packed)
      case $rcount$rbytes$rparts in ''|*[!0-9]*) keep=1; echo "slots-run: the file list from ${name:-$host} is unreadable; files stay in ~/.bb-slots/work/$key there" >&2 ;; esac
      if [ -z "$keep" ] && [ ! -s "$dir/base.json" ]; then keep=1; echo "slots-run: could not record this worktree before the run; files written on ${name:-$host} stay in ~/.bb-slots/work/$key there" >&2; fi
      if [ -z "$keep" ]; then
        if [ "$rdel" = 1 ] && ! bb file read --host "$host" "$ret.del" >"$dir/del" 2>/dev/null; then keep=1; fi
        set --; i=1
        while [ -z "$keep" ] && [ "$i" -le "$rparts" ]; do
          bb file read --host "$host" "$ret.$i" >"$dir/p$i" 2>/dev/null || { keep=1; break; }
          set -- "$@" "$dir/p$i"; i=$((i + 1))
        done
        if [ -n "$keep" ]; then echo "slots-run: could not read the files written on ${name:-$host}; they stay in $ret.* there" >&2
        else node -e "$APPLY_JS" "$root" "$dir/base.json" "$dir/files" "$dir/del" "$rcount" "$rbytes" "${name:-$host}" "~/.bb-slots/work/$key" "$@" || { keep=1; echo "slots-run: files from ${name:-$host} stay in $ret.* there" >&2; }; fi
      fi ;;
    *) echo "slots-run: files written on ${name:-$host} were not brought back (packing failed); they stay in ~/.bb-slots/work/$key there" >&2 ;;
  esac
  [ -n "$keep" ] && return
  [ "$rdel" = 1 ] && bb file remove --yes --host "$host" "$ret.del" >/dev/null 2>&1
  i=0; while [ "$i" -le "${rparts:-0}" ]; do
    if [ "$i" -eq 0 ]; then f=$ret.meta; else f=$ret.$i; fi
    bb file remove --yes --host "$host" "$f" >/dev/null 2>&1; i=$((i + 1))
  done
}
# Copy the worktree (tracked and untracked files, not ignored ones) to the leased machine and run the command there.
git_snapshot() (
  cd "$root" || exit 1
  export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
  format=$(git rev-parse --show-object-format) && index=$(git rev-parse --git-path index) || exit 1
  snapshot=$dir/.git
  git -c init.defaultRefFormat=files init -q --bare --template= --object-format="$format" "$snapshot" &&
    git --git-dir="$snapshot" config core.bare false &&
    git rev-list --parents -n 1 HEAD >"$snapshot/slots-head" &&
    read -r head parents <"$snapshot/slots-head" &&
    printf '%s\n' "$head" >"$snapshot/HEAD" &&
    git --no-optional-locks status --porcelain -z >"$snapshot/slots-status" &&
    cp "$index" "$snapshot/index" &&
    GIT_INDEX_FILE="$snapshot/index" git -c core.fsmonitor=false update-index --no-fsmonitor --no-untracked-cache --no-split-index || exit 1
  # The parent list is space-delimited hex object IDs. Preserve the source boundary when HEAD is already shallow.
  : >"$dir/objects"
  : >"$dir/tree-objects"
  for commit in "$head" $parents; do
    tree=$(git rev-parse "$commit^{tree}") &&
      printf '%s\n' "$commit" "$tree" >>"$dir/objects" &&
      git ls-tree -rt --format="%(objectmode) %(objectname)" "$commit" >>"$dir/tree-objects" || exit 1
    if [ "$commit" != "$head" ] || [ -z "$parents" ]; then
      git cat-file commit "$commit" >"$dir/commit" || exit 1
      if sed -n '/^$/q; /^parent /p' "$dir/commit" | grep -q .; then
        printf '%s\n' "$commit" >>"$snapshot/shallow" || exit 1
      fi
    fi
  done
  GIT_INDEX_FILE="$snapshot/index" git ls-files --stage --sparse >"$dir/index-objects" || exit 1
  if ! awk '$1 == "160000" || ($1 == "040000" && NF > 2) { exit 1 } { print $2 }' \
    "$dir/tree-objects" "$dir/index-objects" >>"$dir/objects"; then
    echo "slots-run: Git snapshots require a full index and a checkout without submodules" >&2
    exit 1
  fi
  git pack-objects "$snapshot/objects/pack/pack" <"$dir/objects" >/dev/null || exit 1

  for option in core.fileMode core.symlinks core.ignoreCase core.precomposeUnicode core.autocrlf core.eol status.renames status.showUntrackedFiles; do
    if value=$(git config --get "$option"); then git --git-dir="$snapshot" config "$option" "$value" || exit 1; fi
  done
  global_ignore=$(git config --path --get core.excludesFile) || global_ignore=${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore
  repo_ignore=$(git rev-parse --git-path info/exclude) || exit 1
  mkdir -p "$snapshot/info" && git --git-dir="$snapshot" config core.excludesFile /dev/null || exit 1
  for ignore in "$global_ignore" "$repo_ignore"; do
    if [ -f "$ignore" ]; then cat "$ignore" && printf '\n' || exit 1; fi
  done >"$snapshot/info/exclude"
)

git_worktree_list() (
  cd "$root" || exit 1
  git ls-files -z -co --deduplicate --exclude-standard >"$dir/paths" || exit 1
  # Match the line-based mirror manifest, but pass literal paths to tar below.
  perl -0ne '
    chomp;
    die "slots-run: paths with newlines are unsupported\n" if /\n/;
    die "slots-run: nested Git worktrees and submodules are unsupported\n" if /\/$/;
    my @parts = split m{/};
    pop @parts;
    my $parent = ".";
    for my $p (@parts) { $parent .= "/$p"; next LINE if -l $parent || !-d _ }
    print "$_\n" if -l || -f _;
  ' "$dir/paths" >"$dir/files"
)

remote_exec() {
  root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "slots-run: the lease is on $host, but this directory is not in a git worktree" >&2; return 69; }
  here=$(pwd -P)
  case $here in "$root") rel=. ;; "$root"/*) rel=${here#"$root"/} ;; *) rel=. ;; esac
  key=$(printf %s "$root" | shasum | cut -c1-16)
  term=term_$(LC_ALL=C tr -dc 23456789abcdefghijkmnpqrstuvwxyz </dev/urandom | head -c 10)
  # Deleted tracked files are left out; the mirror drops them through its manifest.
  if [ -n "$gitmode" ]; then
    key=$key-git
    if ! git_worktree_list || ! git_snapshot; then
      echo "slots-run: could not capture a standalone Git snapshot" >&2; retry=1; return 69
    fi
  else
    (cd "$root" && git ls-files -z -co --exclude-standard | tr '\0' '\n' | while IFS= read -r f; do { [ -e "$f" ] || [ -h "$f" ]; } && printf '%s\n' "$f"; done) >"$dir/files" || return 69
  fi
  (cd "$root" && git ls-files -z -o -i --exclude-standard) >"$dir/ignored" 2>/dev/null || : >"$dir/ignored"
  # What each returnable path looks like now; a returned file overwrites only a local copy that still matches this.
  node -e "$BASE_JS" "$root" "$dir/files" "$dir/ignored" "$dir/base.json" "${SLOTS_RUN_BASELINE_MAX:-536870912}" 2>/dev/null || rm -f "$dir/base.json"
  upload=${SLOTS_RUN_UPLOAD_DIR:-/tmp}/bb-slots-$term.b64
  if [ -n "$gitmode" ]; then
    hash=git
    if ! { tr '\n' '\0' <"$dir/files" >"$dir/files0" &&
      COPYFILE_DISABLE=1 tar -cf "$dir/upload.tar" -C "$root" --null -T "$dir/files0" &&
      COPYFILE_DISABLE=1 tar -rf "$dir/upload.tar" -C "$dir" .git; }; then
      echo "slots-run: could not archive the Git snapshot" >&2; retry=1; return 69
    fi
    gzip -c "$dir/upload.tar" | base64 | bb file write --host "$host" --stdin "$upload" >/dev/null 2>"$dir/err"
  else
    hash=$(tar cf - -C "$root" -T "$dir/files" | shasum | cut -c1-40)
    tar czf - -C "$root" -T "$dir/files" | base64 | bb file write --host "$host" --stdin "$upload" >/dev/null 2>"$dir/err"
  fi
  if [ "$?" -ne 0 ]; then
    echo "slots-run: could not copy the worktree to $host: $(tail -n 1 "$dir/err")" >&2; retry=1; return 69
  fi
  nonce=$(LC_ALL=C tr -dc 23456789abcdefghijkmnpqrstuvwxyz </dev/urandom | head -c 24)
  name=$(bb machine show --json "$host" 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{process.stdout.write(JSON.parse(s).name||"")}catch{}})' 2>/dev/null)
  echo "slots-run: running on ${name:-$host}" >&2
  bb terminal run --machine "$host" --id "$term" --timeout 12h --max-output-bytes 1048576 -- sh -c "$RUNNER" sh "$key" "$rel" "$hash" "$upload" "$nonce" "${SLOTS_RUN_RETURN_MAX:-1073741824}" "$PL" "$gitmode" "$@" >"$dir/out" 2>&1
  code=$?
  if [ -n "$interrupted" ]; then bb terminal close "$term" >/dev/null 2>&1; grep -v "^Terminal $term " "$dir/out"; return 130; fi
  # bb prints no status line for exit 0: the captured output is the result, no terminal lookup.
  if [ "$code" -eq 0 ]; then known=1; sed "\$s/Terminal $term exited with code 0\.\$//; \${/^\$/d;}" "$dir/out"; return 0; fi
  # bb appends its status even when the command did not end its last line.
  while :; do
    last=$(tail -n 1 "$dir/out")
    case $last in
      *"Terminal $term exited with code $code.")
        known=1
        if [ "$code" -ne 124 ] && [ "$code" -ne 130 ] && [ "$(tail -n 2 "$dir/out" | head -n 1)" = "slots-run setup-failed $nonce" ]; then retry=1; fi
        sed "\$s/Terminal $term exited with code $code\.\$//; \${/^$/d;}" "$dir/out"
        return "$code" ;;
      *"Terminal $term is still running"*)
        if [ "$code" -eq 124 ]; then
          sed "\$s/Terminal $term is still running.*\$//; \${/^$/d;}" "$dir/out"
          bb terminal close "$term" >/dev/null 2>&1
          echo "slots-run: the run on $host timed out after 12h and was stopped" >&2; return 124
        fi ;;
    esac
    state=$(bb terminal show "$term" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{let t=JSON.parse(s);if(Number.isInteger(t.exitCode)&&t.exitCode>=0&&t.exitCode<=255)console.log("exit "+t.exitCode);else if(t.status==="running")console.log("running")}catch{}})')
    case $state in
      "exit "*)
        code=${state#exit }; known=1
        if bb terminal output "$term" >"$dir/out" 2>/dev/null; then
          sed -E "\$s/Terminal $term (exited with code [0-9]*[.]|is still running.*)\$//; \${/^$/d;}" "$dir/out" >"$dir/scroll"
          if [ "$code" -ne 124 ] && [ "$code" -ne 130 ] && [ "$(tail -n 1 "$dir/scroll")" = "slots-run setup-failed $nonce" ]; then retry=1; fi
          cat "$dir/scroll"
        else
          echo "slots-run: output of the run on ${name:-$host} is no longer available" >&2
        fi
        return "$code" ;;
      running)
        # Re-attach at most twice; a wait that keeps failing leaves the outcome unknown.
        waits=$((${waits:-0} + 1)); [ "$waits" -le 2 ] || break
        bb terminal wait "$term" --timeout 12h >"$dir/out" 2>&1; code=$?
        if [ "$code" -eq 0 ]; then known=1; sed "\$s/Terminal $term exited with code 0\.\$//; \${/^\$/d;}" "$dir/out"; return 0; fi ;;
      *) break ;;
    esac
  done
  cat "$dir/out"
  bb terminal close "$term" >/dev/null 2>&1
  echo "slots-run: the run on $host failed to start or lost its machine (bb exit $code)" >&2
  return 69
}
# The files the command wrote come back only when it ended with a known exit code and this wrapper was not interrupted.
remote_run() {
  known=
  remote_exec "$@"; rcode=$?
  if [ -n "$known" ] && [ -z "$retry" ] && [ -z "$interrupted" ]; then bring_back; fi
  return "$rcode"
}
trap 'cleanup' EXIT
trap 'interrupted=1' INT TERM HUP
pool=heavy job= est= priority= timeout= place=project needs= host= interrupted= retry= gitmode=
while [ "$#" -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    --spill) place=auto; shift; if [ "${1:-}" = auto ]; then shift; fi ;;
    --anywhere) place=auto; shift ;;
    --local) place=local; shift ;;
    --git) gitmode=1; shift ;;
    --needs) shift; [ "$#" -gt 0 ] || exit 64; needs=$1; shift ;;
    --pool|--job|--est|--priority|--timeout)
      option=$1; shift; [ "$#" -gt 0 ] || exit 64
      case $option in
        --pool) pool=$1 ;; --job) job=$1 ;; --est) est=$1 ;;
        --priority) priority=$1 ;; --timeout) timeout=$1 ;;
      esac
      shift ;;
    *) exit 64 ;;
  esac
done
[ "$#" -gt 0 ] && [ -n "$job" ] && [ -n "$est" ] || exit 64
root=$(git rev-parse --show-toplevel 2>/dev/null) || { root=; place=local; echo "slots-run: keeping local because this directory is not in a git worktree" >&2; }
first=1
for arg in "$@"; do
  if [ "$first" = 1 ]; then first=0; continue; fi
  path=${arg#*=}; case $path in '~/'*) path=$HOME/${path#\~/} ;; esac
  case $path in /*)
    parent=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P) || parent=
    case $path in *"/../"*|*/..|*/./*) parent= ;; esac
    if [ -n "$root" ] && [ -n "$parent" ] && [ ! -L "$path" ]; then
      case $parent in "$root"|"$root"/*) continue ;; esac
    fi
    place=local; echo "slots-run: keeping local because argument names a path outside the worktree: $arg" >&2 ;;
  esac
done
acquire() {
line=$(
  set -- --pool "$pool" --job "$job" --est "$est"
  [ -z "$priority" ] || set -- "$@" --priority "$priority"
  # The command runs here, so a local-model use pins this Mac rather than taking another device.
  [ "$pool" != local-model ] || set -- "$@" --device local
  [ -z "$timeout" ] || set -- "$@" --timeout "$timeout"
  [ "$pool" != heavy ] || set -- "$@" --place "$place"
  [ -z "$needs" ] || set -- "$@" --needs "$needs"
  bb slots acquire "$@"
)
status=$?
[ "$status" -eq 0 ] || exit "$status"
case $line in *'
'*) exit 70 ;; esac
read -r label use label2 lease label3 renew label4 host extra <<EOF_LINE
$line
EOF_LINE
case $use in use-*) digits=${use#use-} ;; *) exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $lease in lease-*) digits=${lease#lease-} ;; *) use=; exit 70 ;; esac
case $digits in ''|*[!0-9]*) use=; exit 70 ;; esac
case $renew in ''|*[!0-9]*|0) use=; exit 70 ;; esac
[ "$renew" -gt 0 ] 2>/dev/null || { use=; exit 70; }
[ "$label" = use ] && [ "$label2" = lease ] && [ "$label3" = renew ] && [ -z "$extra" ] || { use=; exit 70; }
# `host <id>` appears only for a spilled lease on another machine.
{ [ -z "$label4" ] && [ -z "$host" ]; } || { [ "$label4" = host ] && [ "$place" != local ] && [ -n "$host" ]; } || { use=; exit 70; }
}
acquire || exit $?
start_heartbeat() {
start=$(ps -o lstart= -p "$$" 2>/dev/null) || start=
(
  trap '' INT TERM HUP
  while :; do
    n=0
    while [ "$n" -lt "$renew" ]; do
      [ ! -e "$dir/stop" ] && kill -0 "$$" 2>/dev/null || exit
      sleep "$interval"; n=$((n + 1))
    done
    [ ! -e "$dir/stop" ] && kill -0 "$$" 2>/dev/null || exit
    if [ -n "$start" ]; then
      current=$(ps -o lstart= -p "$$" 2>/dev/null) || exit
      [ -n "$current" ] && [ "$current" = "$start" ] || exit
    fi
    bb slots heartbeat --use "$use" >/dev/null 2>&1 & hp=$!
    n=0
    while kill -0 "$hp" 2>/dev/null && [ "$n" -lt 20 ]; do
      if [ -e "$dir/stop" ]; then kill -KILL "$hp" 2>/dev/null; wait "$hp" 2>/dev/null; exit; fi
      sleep "$interval"; n=$((n + 1))
    done
    if kill -0 "$hp" 2>/dev/null; then kill -KILL "$hp" 2>/dev/null; fi
    wait "$hp" 2>/dev/null; result=$?
    [ "$result" -ne 2 ] || exit
  done
) & loop=$!
}
start_heartbeat
if [ -n "$host" ]; then remote_run "$@"; else "$@"; fi
status=$?
if [ -n "$retry" ] && [ -z "$interrupted" ]; then
  echo "slots-run: remote setup failed before the command started; retrying locally" >&2
  : > "$dir/stop"; kill "$loop" 2>/dev/null; wait "$loop" 2>/dev/null; loop=
  bb slots done "$use" >/dev/null 2>&1; use=; host=; rm -f "$dir/stop"
  place=local
  acquire || exit $?
  start_heartbeat
  "$@"; status=$?
fi
exit "$status"
