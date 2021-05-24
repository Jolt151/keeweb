import { Launcher } from 'comp/launcher';
import { StorageCache } from 'storage/impl/storage-cache';
import { StorageDropbox } from 'storage/impl/storage-dropbox';
import { StorageFile } from 'storage/impl/storage-file';
import { StorageFileCache } from 'storage/impl/storage-file-cache';
// import { StorageGDrive } from 'storage/impl/storage-gdrive';
// import { StorageOneDrive } from 'storage/impl/storage-onedrive';
// import { StorageWebDav } from 'storage/impl/storage-webdav';
import { createOAuthSession } from 'storage/pkce';

const BuiltInStorage = {
    file: new StorageFile(),
    cache: Launcher ? new StorageFileCache() : new StorageCache()
};

const ThirdPartyStorage = {
    dropbox: new StorageDropbox()
    // gdrive: new StorageGDrive(),
    // onedrive: new StorageOneDrive(),
    // webdav: new StorageWebDav()
};

const Storage = {
    ...BuiltInStorage,
    ...ThirdPartyStorage
};

requestAnimationFrame(createOAuthSession);

export { Storage };