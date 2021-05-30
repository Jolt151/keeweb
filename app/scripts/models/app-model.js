import { Events } from 'framework/events';
import { Storage } from 'storage';
import { SearchResultCollection } from 'collections/search-result-collection';
import { RuntimeInfo } from 'const/runtime-info';
import { UsbListener } from 'comp/app/usb-listener';
import { NativeModules } from 'comp/launcher/native-modules';
import { Timeouts } from 'const/timeouts';
import { AppSettingsModel } from 'models/app-settings-model';
import { EntryModel } from 'models/entry-model';
import { FileInfoModel } from 'models/file-info-model';
import { GroupModel } from 'models/group-model';
import { YubiKeyOtpModel } from 'models/otp-device/yubikey-otp-model';
import { Menu } from 'models/menu/menu-model';
import { DateFormat } from 'comp/i18n/date-format';
import { Launcher } from 'comp/launcher';
import { UrlFormat } from 'util/formatting/url-format';
import { IdGenerator } from 'util/generators/id-generator';
import { Logger } from 'util/logger';
import { noop } from 'util/fn';
import debounce from 'lodash/debounce';
import 'util/kdbxweb/protected-value';

class AppModel {
    tags = [];
    menu = new Menu();
    filter = {};
    sort = 'title';
    settings = AppSettingsModel;
    activeEntryId = null;
    isBeta = RuntimeInfo.beta;
    advancedSearch = null;
    attachedYubiKeysCount = 0;
    memoryPasswordStorage = {};
    fileUnlockPromise = null;
    hardwareDecryptInProgress = false;
    mainWindowBlurTimer = null;

    addFile(file) {
        file.on('change:dirty', (file, dirty) => {
            if (dirty && this.settings.autoSaveInterval === -1) {
                this.syncFile(file);
            }
        });

        Events.emit('file-opened');

        if (this.fileUnlockPromise) {
            this.appLogger.info('Running pending file unlock operation');
            this.fileUnlockPromise.resolve(file);
            this.fileUnlockPromise = null;
            Events.emit('unlock-message-changed', null);
        }
    }

    addFilter(filter) {
        this.setFilter(Object.assign(this.filter, filter));
    }

    setSort(sort) {
        this.sort = sort;
        this.setFilter(this.filter);
    }

    getEntries() {
        const entries = this.getEntriesByFilter(this.filter, this.files);
        entries.sortEntries(this.sort, this.filter);
        if (this.filter.trash) {
            this.addTrashGroups(entries);
        }
        return entries;
    }

    getEntriesByFilter(filter, files) {
        const preparedFilter = this.prepareFilter(filter);
        const entries = new SearchResultCollection();

        const devicesToMatchOtpEntries = files.filter((file) => file.backend === 'otp-device');

        const matchedOtpEntrySet = this.settings.yubiKeyMatchEntries ? new Set() : undefined;

        files
            .filter((file) => file.backend !== 'otp-device')
            .forEach((file) => {
                file.forEachEntry(preparedFilter, (entry) => {
                    if (matchedOtpEntrySet) {
                        for (const device of devicesToMatchOtpEntries) {
                            const matchingEntry = device.getMatchingEntry(entry);
                            if (matchingEntry) {
                                matchedOtpEntrySet.add(matchingEntry);
                            }
                        }
                    }
                    entries.push(entry);
                });
            });

        if (devicesToMatchOtpEntries.length) {
            for (const device of devicesToMatchOtpEntries) {
                device.forEachEntry(preparedFilter, (entry) => {
                    if (!matchedOtpEntrySet || !matchedOtpEntrySet.has(entry)) {
                        entries.push(entry);
                    }
                });
            }
        }

        return entries;
    }

    addTrashGroups(collection) {
        this.files.forEach((file) => {
            const trashGroup = file.getTrashGroup && file.getTrashGroup();
            if (trashGroup) {
                trashGroup.getOwnSubGroups().forEach((group) => {
                    collection.unshift(GroupModel.fromGroup(group, file, trashGroup));
                });
            }
        });
    }

    getFirstSelectedGroupForCreation() {
        const selGroupId = this.filter.group;
        let file, group;
        if (selGroupId) {
            this.files.some((f) => {
                file = f;
                group = f.getGroup(selGroupId);
                return group;
            });
        }
        if (!group) {
            file = this.files.find((f) => f.active && !f.readOnly);
            group = file.groups[0];
        }
        return { group, file };
    }

    completeUserNames(part) {
        const userNames = {};
        this.files.forEach((file) => {
            file.forEachEntry(
                { text: part, textLower: part.toLowerCase(), advanced: { user: true } },
                (entry) => {
                    const userName = entry.user;
                    if (userName) {
                        userNames[userName] = (userNames[userName] || 0) + 1;
                    }
                }
            );
        });
        const matches = Object.entries(userNames);
        matches.sort((x, y) => y[1] - x[1]);
        const maxResults = 5;
        if (matches.length > maxResults) {
            matches.length = maxResults;
        }
        return matches.map((m) => m[0]);
    }

    getEntryTemplates() {
        const entryTemplates = [];
        this.files.forEach((file) => {
            file.forEachEntryTemplate?.((entry) => {
                entryTemplates.push({ file, entry });
            });
        });
        return entryTemplates;
    }

    canCreateEntries() {
        return this.files.some((f) => f.active && !f.readOnly);
    }

    createNewEntry(args) {
        const sel = this.getFirstSelectedGroupForCreation();
        if (args?.template) {
            if (sel.file !== args.template.file) {
                sel.file = args.template.file;
                sel.group = args.template.file.groups[0];
            }
            const templateEntry = args.template.entry;
            const newEntry = EntryModel.newEntry(sel.group, sel.file);
            newEntry.copyFromTemplate(templateEntry);
            return newEntry;
        } else {
            return EntryModel.newEntry(sel.group, sel.file, {
                tag: this.filter.tag
            });
        }
    }

    createNewEntryWithFields(group, fields) {
        return EntryModel.newEntryWithFields(group, fields);
    }

    createNewGroup() {
        const sel = this.getFirstSelectedGroupForCreation();
        return GroupModel.newGroup(sel.group, sel.file);
    }

    createNewGroupWithName(group, file, name) {
        const newGroup = GroupModel.newGroup(group, file);
        newGroup.setName(name);
        return newGroup;
    }

    createNewTemplateEntry() {
        const file = this.getFirstSelectedGroupForCreation().file;
        const group = file.getEntryTemplatesGroup() || file.createEntryTemplatesGroup();
        return EntryModel.newEntry(group, file);
    }

    getStoreOpts(file) {
        const opts = file.opts;
        const storage = file.storage;
        if (Storage[storage] && Storage[storage].fileOptsToStoreOpts && opts) {
            return Storage[storage].fileOptsToStoreOpts(opts, file);
        }
        return null;
    }

    setFileOpts(file, opts) {
        const storage = file.storage;
        if (Storage[storage] && Storage[storage].storeOptsToFileOpts && opts) {
            file.opts = Storage[storage].storeOptsToFileOpts(opts, file);
        }
    }

    fileOpened(file, data, params) {
        if (file.storage === 'file') {
            Storage.file.watch(
                file.path,
                debounce(() => {
                    this.syncFile(file);
                }, Timeouts.FileChangeSync)
            );
        }
        if (file.isKeyChangePending(true)) {
            Events.emit('key-change-pending', { file });
        }
        const backup = file.backup;
        if (data && backup && backup.enabled && backup.pending) {
            this.scheduleBackupFile(file, data);
        }
        if (this.settings.yubiKeyAutoOpen) {
            if (
                this.attachedYubiKeysCount > 0 &&
                !this.files.some((f) => f.backend === 'otp-device')
            ) {
                this.tryOpenOtpDeviceInBackground();
            }
        }
        if (this.settings.deviceOwnerAuth) {
            this.saveEncryptedPassword(file, params);
        }
    }

    removeFileInfo(id) {
        Storage.cache.remove(id);
        this.fileInfos.remove(id);
        this.fileInfos.save();
    }

    getFileInfo(file) {
        return (
            this.fileInfos.get(file.id) ||
            this.fileInfos.getMatch(file.storage, file.name, file.path)
        );
    }

    syncFile(file, options, callback) {
        if (file.demo) {
            return callback && callback();
        }
        if (file.syncing) {
            return callback && callback('Sync in progress');
        }
        if (!file.active) {
            return callback && callback('File is closed');
        }
        if (!options) {
            options = {};
        }
        const logger = new Logger('sync', file.name);
        const storage = options.storage || file.storage;
        let path = options.path || file.path;
        const opts = options.opts || file.opts;
        if (storage && Storage[storage].getPathForName && (!path || storage !== file.storage)) {
            path = Storage[storage].getPathForName(file.name);
        }
        const optionsForLogging = { ...options };
        if (optionsForLogging.opts && optionsForLogging.opts.password) {
            optionsForLogging.opts = { ...optionsForLogging.opts };
            optionsForLogging.opts.password = '***';
        }
        logger.info('Sync started', storage, path, optionsForLogging);
        let fileInfo = this.getFileInfo(file);
        if (!fileInfo) {
            logger.info('Create new file info');
            const dt = new Date();
            fileInfo = new FileInfoModel({
                id: IdGenerator.uuid(),
                name: file.name,
                storage: file.storage,
                path: file.path,
                opts: this.getStoreOpts(file),
                modified: file.modified,
                editState: null,
                rev: null,
                syncDate: dt,
                openDate: dt,
                backup: file.backup
            });
        }
        file.setSyncProgress();
        const complete = (err) => {
            if (!file.active) {
                return callback && callback('File is closed');
            }
            logger.info('Sync finished', err || 'no error');
            file.setSyncComplete(path, storage, err ? err.toString() : null);
            fileInfo.set({
                name: file.name,
                storage,
                path,
                opts: this.getStoreOpts(file),
                modified: file.dirty ? fileInfo.modified : file.modified,
                editState: file.dirty ? fileInfo.editState : file.getLocalEditState(),
                syncDate: file.syncDate,
                chalResp: file.chalResp
            });
            if (this.settings.rememberKeyFiles === 'data') {
                fileInfo.set({
                    keyFileName: file.keyFileName || null,
                    keyFileHash: file.getKeyFileHash()
                });
            }
            if (!this.fileInfos.get(fileInfo.id)) {
                this.fileInfos.unshift(fileInfo);
            }
            this.fileInfos.save();
            if (callback) {
                callback(err);
            }
        };
        if (!storage) {
            if (!file.modified && fileInfo.id === file.id) {
                logger.info('Local, not modified');
                return complete();
            }
            logger.info('Local, save to cache');
            file.getData((data, err) => {
                if (err) {
                    return complete(err);
                }
                Storage.cache.save(fileInfo.id, null, data, (err) => {
                    logger.info('Saved to cache', err || 'no error');
                    complete(err);
                    if (!err) {
                        this.scheduleBackupFile(file, data);
                    }
                });
            });
        } else {
            const maxLoadLoops = 3;
            let loadLoops = 0;
            const loadFromStorageAndMerge = () => {
                if (++loadLoops === maxLoadLoops) {
                    return complete('Too many load attempts');
                }
                logger.info('Load from storage, attempt ' + loadLoops);
                Storage[storage].load(path, opts, (err, data, stat) => {
                    logger.info('Load from storage', stat, err || 'no error');
                    if (!file.active) {
                        return complete('File is closed');
                    }
                    if (err) {
                        return complete(err);
                    }
                    file.mergeOrUpdate(data, options.remoteKey, (err) => {
                        logger.info('Merge complete', err || 'no error');
                        this.refresh();
                        if (err) {
                            if (err.code === 'InvalidKey') {
                                logger.info('Remote key changed, request to enter new key');
                                Events.emit('remote-key-changed', { file });
                            }
                            return complete(err);
                        }
                        if (stat && stat.rev) {
                            logger.info('Update rev in file info');
                            fileInfo.rev = stat.rev;
                        }
                        file.syncDate = new Date();
                        if (file.modified) {
                            logger.info('Updated sync date, saving modified file');
                            saveToCacheAndStorage();
                        } else if (file.dirty) {
                            if (this.settings.disableOfflineStorage) {
                                logger.info('File is dirty and cache is disabled');
                                return complete(err);
                            }
                            logger.info('Saving not modified dirty file to cache');
                            Storage.cache.save(fileInfo.id, null, data, (err) => {
                                if (err) {
                                    return complete(err);
                                }
                                file.dirty = false;
                                logger.info('Complete, remove dirty flag');
                                complete();
                            });
                        } else {
                            logger.info('Complete, no changes');
                            complete();
                        }
                    });
                });
            };
            const saveToStorage = (data) => {
                logger.info('Save data to storage');
                const storageRev = fileInfo.storage === storage ? fileInfo.rev : undefined;
                Storage[storage].save(
                    path,
                    opts,
                    data,
                    (err, stat) => {
                        if (err && err.revConflict) {
                            logger.info('Save rev conflict, reloading from storage');
                            loadFromStorageAndMerge();
                        } else if (err) {
                            logger.info('Error saving data to storage');
                            complete(err);
                        } else {
                            if (stat && stat.rev) {
                                logger.info('Update rev in file info');
                                fileInfo.rev = stat.rev;
                            }
                            if (stat && stat.path) {
                                logger.info('Update path in file info', stat.path);
                                file.path = stat.path;
                                fileInfo.path = stat.path;
                                path = stat.path;
                            }
                            file.syncDate = new Date();
                            logger.info('Save to storage complete, update sync date');
                            this.scheduleBackupFile(file, data);
                            complete();
                        }
                    },
                    storageRev
                );
            };
            const saveToCacheAndStorage = () => {
                logger.info('Getting file data for saving');
                file.getData((data, err) => {
                    if (err) {
                        return complete(err);
                    }
                    if (storage === 'file') {
                        logger.info('Saving to file storage');
                        saveToStorage(data);
                    } else if (!file.dirty) {
                        logger.info('Saving to storage, skip cache because not dirty');
                        saveToStorage(data);
                    } else if (this.settings.disableOfflineStorage) {
                        logger.info('Saving to storage because cache is disabled');
                        saveToStorage(data);
                    } else {
                        logger.info('Saving to cache');
                        Storage.cache.save(fileInfo.id, null, data, (err) => {
                            if (err) {
                                return complete(err);
                            }
                            file.dirty = false;
                            logger.info('Saved to cache, saving to storage');
                            saveToStorage(data);
                        });
                    }
                });
            };
            logger.info('Stat file');
            Storage[storage].stat(path, opts, (err, stat) => {
                if (!file.active) {
                    return complete('File is closed');
                }
                if (err) {
                    if (err.notFound) {
                        logger.info('File does not exist in storage, creating');
                        saveToCacheAndStorage();
                    } else if (file.dirty) {
                        if (this.settings.disableOfflineStorage) {
                            logger.info('Stat error, dirty, cache is disabled', err || 'no error');
                            return complete(err);
                        }
                        logger.info('Stat error, dirty, save to cache', err || 'no error');
                        file.getData((data, e) => {
                            if (e) {
                                logger.error('Error getting file data', e);
                                return complete(err);
                            }
                            Storage.cache.save(fileInfo.id, null, data, (e) => {
                                if (e) {
                                    logger.error('Error saving to cache', e);
                                }
                                if (!e) {
                                    file.dirty = false;
                                }
                                logger.info('Saved to cache, exit with error', err || 'no error');
                                complete(err);
                            });
                        });
                    } else {
                        logger.info('Stat error, not dirty', err || 'no error');
                        complete(err);
                    }
                } else if (stat.rev === fileInfo.rev) {
                    if (file.modified) {
                        logger.info('Stat found same version, modified, saving');
                        saveToCacheAndStorage();
                    } else {
                        logger.info('Stat found same version, not modified');
                        complete();
                    }
                } else {
                    logger.info('Found new version, loading from storage');
                    loadFromStorageAndMerge();
                }
            });
        }
    }

    deleteAllCachedFiles() {
        for (const fileInfo of this.fileInfos) {
            if (fileInfo.storage && !fileInfo.modified) {
                Storage.cache.remove(fileInfo.id);
            }
        }
    }

    clearStoredKeyFiles() {
        for (const fileInfo of this.fileInfos) {
            fileInfo.set({
                keyFileName: null,
                keyFilePath: null,
                keyFileHash: null
            });
        }
        this.fileInfos.save();
    }

    unsetKeyFile(fileId) {
        const fileInfo = this.fileInfos.get(fileId);
        fileInfo.set({
            keyFileName: null,
            keyFilePath: null,
            keyFileHash: null
        });
        this.fileInfos.save();
    }

    setFileBackup(fileId, backup) {
        const fileInfo = this.fileInfos.get(fileId);
        if (fileInfo) {
            fileInfo.backup = backup;
        }
        this.fileInfos.save();
    }

    backupFile(file, data, callback) {
        const opts = file.opts;
        let backup = file.backup;
        const logger = new Logger('backup', file.name);
        if (!backup || !backup.storage || !backup.path) {
            return callback('Invalid backup settings');
        }
        let path = backup.path.replace('{date}', DateFormat.dtStrFs(new Date()));
        logger.info('Backup file to', backup.storage, path);
        const saveToFolder = () => {
            if (Storage[backup.storage].getPathForName) {
                path = Storage[backup.storage].getPathForName(path);
            }
            Storage[backup.storage].save(path, opts, data, (err) => {
                if (err) {
                    logger.error('Backup error', err);
                } else {
                    logger.info('Backup complete');
                    backup = file.backup;
                    backup.lastTime = Date.now();
                    delete backup.pending;
                    file.backup = backup;
                    this.setFileBackup(file.id, backup);
                }
                callback(err);
            });
        };
        let folderPath = UrlFormat.fileToDir(path);
        if (Storage[backup.storage].getPathForName) {
            folderPath = Storage[backup.storage].getPathForName(folderPath).replace('.kdbx', '');
        }
        Storage[backup.storage].stat(folderPath, opts, (err) => {
            if (err) {
                if (err.notFound) {
                    logger.info('Backup folder does not exist');
                    if (!Storage[backup.storage].mkdir) {
                        return callback('Mkdir not supported by ' + backup.storage);
                    }
                    Storage[backup.storage].mkdir(folderPath, (err) => {
                        if (err) {
                            logger.error('Error creating backup folder', err);
                            callback('Error creating backup folder');
                        } else {
                            logger.info('Backup folder created');
                            saveToFolder();
                        }
                    });
                } else {
                    logger.error('Stat folder error', err);
                    callback('Cannot stat backup folder');
                }
            } else {
                logger.info('Backup folder exists, saving');
                saveToFolder();
            }
        });
    }

    scheduleBackupFile(file, data) {
        const backup = file.backup;
        if (!backup || !backup.enabled) {
            return;
        }
        const logger = new Logger('backup', file.name);
        let needBackup = false;
        if (!backup.lastTime) {
            needBackup = true;
            logger.info('No last backup time, backup now');
        } else {
            const dt = new Date(backup.lastTime);
            switch (backup.schedule) {
                case '0':
                    break;
                case '1d':
                    dt.setDate(dt.getDate() + 1);
                    break;
                case '1w':
                    dt.setDate(dt.getDate() + 7);
                    break;
                case '1m':
                    dt.setMonth(dt.getMonth() + 1);
                    break;
                default:
                    return;
            }
            if (dt.getTime() <= Date.now()) {
                needBackup = true;
            }
            logger.info(
                'Last backup time: ' +
                    new Date(backup.lastTime) +
                    ', schedule: ' +
                    backup.schedule +
                    ', next time: ' +
                    dt +
                    ', ' +
                    (needBackup ? 'backup now' : 'skip backup')
            );
        }
        if (!backup.pending) {
            backup.pending = true;
            this.setFileBackup(file.id, backup);
        }
        if (needBackup) {
            this.backupFile(file, data, noop);
        }
    }

    usbDevicesChanged() {
        const attachedYubiKeysCount = this.attachedYubiKeysCount;

        this.attachedYubiKeysCount = UsbListener.attachedYubiKeys;

        if (!this.settings.yubiKeyAutoOpen) {
            return;
        }

        const isNewYubiKey = UsbListener.attachedYubiKeys > attachedYubiKeysCount;
        const hasOpenFiles = this.files.some(
            (file) => file.active && file.backend !== 'otp-device'
        );

        if (isNewYubiKey && hasOpenFiles && !this.openingOtpDevice) {
            this.tryOpenOtpDeviceInBackground();
        }
    }

    tryOpenOtpDeviceInBackground() {
        this.applogger.info('Auto-opening a YubiKey');
        this.openOtpDevice((err) => {
            this.applogger.info('YubiKey auto-open complete', err);
        });
    }

    openOtpDevice(callback) {
        this.openingOtpDevice = true;
        const device = new YubiKeyOtpModel();
        device.open((err) => {
            this.openingOtpDevice = false;
            if (!err) {
                this.addFile(device);
            }
            callback(err);
        });
        return device;
    }

    getMatchingOtpEntry(entry) {
        if (!this.settings.yubiKeyMatchEntries) {
            return null;
        }
        for (const file of this.files) {
            if (file.backend === 'otp-device') {
                const matchingEntry = file.getMatchingEntry(entry);
                if (matchingEntry) {
                    return matchingEntry;
                }
            }
        }
    }

    saveEncryptedPassword(file, params) {
        if (!this.settings.deviceOwnerAuth || params.encryptedPassword) {
            return;
        }
        NativeModules.hardwareEncrypt(params.password)
            .then((encryptedPassword) => {
                encryptedPassword = encryptedPassword.toBase64();
                const fileInfo = this.fileInfos.get(file.id);
                const encryptedPasswordDate = new Date();
                file.encryptedPassword = encryptedPassword;
                file.encryptedPasswordDate = encryptedPasswordDate;
                if (this.settings.deviceOwnerAuth === 'file') {
                    fileInfo.encryptedPassword = encryptedPassword;
                    fileInfo.encryptedPasswordDate = encryptedPasswordDate;
                    this.fileInfos.save();
                } else if (this.settings.deviceOwnerAuth === 'memory') {
                    this.memoryPasswordStorage[file.id] = {
                        value: encryptedPassword,
                        date: encryptedPasswordDate
                    };
                }
            })
            .catch((e) => {
                file.encryptedPassword = null;
                file.encryptedPasswordDate = null;
                delete this.memoryPasswordStorage[file.id];
                this.appLogger.error('Error encrypting password', e);
            });
    }

    getMemoryPassword(fileId) {
        return this.memoryPasswordStorage[fileId];
    }

    checkEncryptedPasswordsStorage() {
        if (this.settings.deviceOwnerAuth === 'file') {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (this.memoryPasswordStorage[fileInfo.id]) {
                    fileInfo.encryptedPassword = this.memoryPasswordStorage[fileInfo.id].value;
                    fileInfo.encryptedPasswordDate = this.memoryPasswordStorage[fileInfo.id].date;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
            for (const file of this.files) {
                if (this.memoryPasswordStorage[file.id]) {
                    file.encryptedPassword = this.memoryPasswordStorage[file.id].value;
                    file.encryptedPasswordDate = this.memoryPasswordStorage[file.id].date;
                }
            }
        } else if (this.settings.deviceOwnerAuth === 'memory') {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (fileInfo.encryptedPassword) {
                    this.memoryPasswordStorage[fileInfo.id] = {
                        value: fileInfo.encryptedPassword,
                        date: fileInfo.encryptedPasswordDate
                    };
                    fileInfo.encryptedPassword = null;
                    fileInfo.encryptedPasswordDate = null;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
        } else {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (fileInfo.encryptedPassword) {
                    fileInfo.encryptedPassword = null;
                    fileInfo.encryptedPasswordDate = null;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
            for (const file of this.files) {
                if (file.encryptedPassword) {
                    file.encryptedPassword = null;
                    file.encryptedPasswordDate = null;
                }
            }
            this.memoryPasswordStorage = {};
        }
    }

    unlockAnyFile(unlockRes, timeout) {
        this.rejectPendingFileUnlockPromise('Replaced with a new operation');
        Events.emit('show-open-view');
        return new Promise((resolve, reject) => {
            this.fileUnlockPromise = { resolve, reject, unlockRes };
            if (timeout) {
                const timer = setTimeout(
                    () => this.rejectPendingFileUnlockPromise('Timeout'),
                    timeout
                );
                this.fileUnlockPromise.resolve = (res) => {
                    clearTimeout(timer);
                    resolve(res);
                };
                this.fileUnlockPromise.reject = (err) => {
                    clearTimeout(timer);
                    reject(err);
                };
            }
            this.appLogger.info('Pending file unlock operation is set');
            Events.emit('unlock-message-changed', unlockRes);
        });
    }

    get unlockMessageRes() {
        return this.fileUnlockPromise?.unlockRes;
    }

    rejectPendingFileUnlockPromise(reason) {
        if (this.fileUnlockPromise) {
            this.appLogger.info('Cancel pending file unlock operation', reason);
            this.fileUnlockPromise.reject(new Error(reason));
            this.fileUnlockPromise = null;
            Events.emit('unlock-message-changed', null);
        }
    }

    mainWindowBlur() {
        if (!this.hardwareDecryptInProgress) {
            this.mainWindowBlurTimer = setTimeout(() => {
                // macOS emits focus-blur-focus event in a row when triggering auto-type from minimized state
                delete this.mainWindowBlurTimer;
                this.rejectPendingFileUnlockPromise('Main window blur');
            }, Timeouts.AutoTypeWindowFocusAfterBlur);
        }
    }

    mainWindowFocus() {
        if (this.mainWindowBlurTimer) {
            clearTimeout(this.mainWindowBlurTimer);
            this.mainWindowBlurTimer = null;
        }
    }

    mainWindowWillClose() {
        this.rejectPendingFileUnlockPromise('Main window will close');
    }

    hardwareDecryptStarted() {
        this.hardwareDecryptInProgress = true;
    }

    hardwareDecryptFinished() {
        this.hardwareDecryptInProgress = false;
        if (!Launcher.isAppFocused()) {
            this.rejectPendingFileUnlockPromise('App is not focused after hardware decrypt');
        }
    }
}

export { AppModel };
