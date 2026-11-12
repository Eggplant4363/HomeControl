package com.homecontrol.panel;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;

import java.io.File;

/**
 * 把「刚下载好的 APK」以 content:// 交出去，只为了让系统安装器能读到它。
 *
 * 为什么不直接 file:// —— Android 7 起（本项目和 Pad 5 都在这个范围）会抛
 * FileUriExposedException；正常做法是 androidx 的 FileProvider，但这套壳刻意不带任何
 * 第三方/Support 依赖（构建就是 aapt2 + javac + d8），所以这里只实现真正用得到的那一小块：
 * <ul>
 * <li>只有 {@code com.homecontrol.panel.upd} 这一个 authority，且 exported=false；</li>
 * <li>只允许访问 {@code getCacheDir()/upd} 目录下的文件，路径越界直接抛；</li>
 * <li>一次只服务一个 URI（安装完成后缓存目录在下次启动/清理时回收）。</li>
 * </ul>
 * 安装意图里带 FLAG_GRANT_READ_URI_PERMISSION，所以安装器不用常驻权限也能读。
 */
public class UpdateProvider extends ContentProvider {

    private static final String TAG = "HomePanel";
    public static final String AUTHORITY = "com.homecontrol.panel.upd";
    public static final String DIR = "upd";
    private static final String MIME_APK = "application/vnd.android.package-archive";

    /** 下载目录：卸载/清缓存时一起没，不占用户的空间 */
    public static File dir(android.content.Context ctx) {
        File d = new File(ctx.getCacheDir(), DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** 在 update 目录里按文件名找文件；越界（含 .. 与子目录）返回 null */
    public static File resolve(android.content.Context ctx, String name) {
        if (name == null) return null;
        File base = dir(ctx);
        String clean = new File(name).getName();
        if (clean.length() == 0 || clean.indexOf('/') > -1) return null;
        File f = new File(base, clean);
        try {
            String basePath = base.getCanonicalPath();
            String filePath = f.getCanonicalPath();
            if (!filePath.startsWith(basePath + File.separator)) return null;
        } catch (Throwable t) { return null; }
        return f;
    }

    public static Uri uriFor(String name) {
        return Uri.parse("content://" + AUTHORITY + "/" + Uri.encode(name));
    }

    @Override
    public boolean onCreate() { return true; }

    private File fileOf(Uri uri) {
        if (uri == null) return null;
        String name = uri.getLastPathSegment();
        if (name == null) return null;
        return resolve(getContext(), Uri.decode(name));
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        File f = fileOf(uri);
        if (f == null || !f.exists()) {
            Log.w(TAG, "update provider: no file for " + uri);
            throw new java.io.FileNotFoundException(String.valueOf(uri));
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) { return MIME_APK; }

    /** 安装器会查 OpenableColumns.DISPLAY_NAME / SIZE，给一份最小的游标 */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File f = fileOf(uri);
        if (f == null) return null;
        String[] cols = projection != null ? projection
                : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = Long.valueOf(f.length());
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override
    public int delete(Uri uri, String selection, String[] args) { return 0; }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
