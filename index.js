/**
* XAPK installer
*  Parses XAPK file and installs to device
*/

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const program = require('commander');
const AdmZip = require('adm-zip');

let XAPKFile;

console.log(`
=== XAPK Installer ===

Written by Jamie Holding (@cube)

`)

program
  .option('-p, --permissions', 'Also install APK permissions')
  .option('-x, --leavetmpdir', 'Leave temporary directory after install')
  .arguments('<xapk>').action(function (xapk) {
    XAPKFile = path.resolve(xapk);
});

program.parse(process.argv);

if (!XAPKFile) {
    throw new Error('Must supply an XAPK file to install');
}

// folder to store temporary files into
const tempFolder = path.join(__dirname, '_tmp');

/**
 * Reads the supplied XAPK file and generates a list of commands to run
 */
function SetupXAPK(file) {
    // open XAPK file
    console.log(`Parsing XAPK file ${file}...`);
    const zip = new AdmZip(file);

    const manifestEntry = zip.getEntry('manifest.json');
    if (manifestEntry === null) {
        throw new Error('Archive does not contain manifest.json file - not an XAPK file!');
    }

    // read manifest.json
    const manifestData = JSON.parse(manifestEntry.getData().toString('utf8'));

    const apksToInstall = [];

    // find base APK
    const baseAPK = manifestData.split_apks.find((apk) => apk.id === 'base');
    if (baseAPK === undefined) {
        throw new Error('Cannot find base APK in manifest.json!');
    }
    apksToInstall.push(baseAPK.file);

    // find all other APKs to install
    manifestData.split_apks.filter((apk) => apk.id !== 'base').forEach((apk) => apksToInstall.push(apk.file));

    // extract APKs to temp folder on disk
    const apksOnDisk = [];
    apksToInstall.forEach((apk) => {
        zip.extractEntryTo(apk, tempFolder, false, true);
        apksOnDisk.push( path.join(tempFolder, path.basename(apk)));
    });

    // build list of ADB commands to run

    // install APKs
    const commandsToExec = [];
    commandsToExec.push({
        cmd: 'adb',
        args: [
            'install-multiple',
            ...apksOnDisk
        ],
    })

    if (program.permissions)
    {
        // grant required permissions - adb shell pm grant [APP ID] [PERMISSION]
        manifestData.permissions.forEach((perm) => {
            commandsToExec.push({
                cmd: 'adb',
                args: [
                    'shell',
                    'pm',
                    'grant',
                    manifestData.package_name,
                    perm
                ],
                failSilently: true,
            });
        });
    }

    // find any expansion files needed
    if (manifestData.expansions) {
        manifestData.expansions.forEach((exp) => {
            // extract OBB to temp folder
            zip.extractEntryTo(exp.file, tempFolder, false, true);

            // mark for sending to device
            commandsToExec.push({
                cmd: 'adb',
                args: [
                    'push',
                    path.join(tempFolder, path.basename(exp.file)),
                    `/sdcard/${exp.install_path}`,
                ],
            });
        });
    }

    console.log(`

Installing APK: ${manifestData.name} [${manifestData.package_name}]

Running ${commandsToExec.length} tasks...
`);

    // return commands to install XAPK
    return Promise.resolve(commandsToExec);
}

/**
 * Run a single command-line command
 */
function ExecCommand(cmd) {
    return new Promise((resolve, reject) => {
        console.log(`Running ${cmd.cmd} ${cmd.args.join(' ')}...`);

        const process = spawn(cmd.cmd, cmd.args, {
            cwd: __dirname,
        });

        process.stdout.on('data', (data) => {
            console.log(data.toString());
        });

        if (!cmd.failSilently)
        {
            process.stderr.on('data', (data) => {
                console.error(data.toString());
            });
        }

        process.on('close', (code) => {
            if (!cmd.failSilently && code !== 0) {
                console.log(`${cmd.cmd} command exited with code ${code}`);
                return reject(new Error(`Error running ${cmd.cmd} (${cmd.args.join(' ')})\ncode ${code}`));
            }
            resolve();
        });
    });
}

/**
 * Run an array of command-line commands in order
 */
function ExecCommands(cmds) {
    const totalCommands = cmds.length;
    return cmds.reduce((prev, next, idx) => {
        return prev.then(() => {
            console.log(`Running task ${idx + 1} / ${totalCommands}`);
            return ExecCommand(next);
        });
    }, Promise.resolve());
}


SetupXAPK(XAPKFile).then((commands) => {
    // execute commands to install apk
    ExecCommands(commands).then(() => {
        console.log('Done!');

        // clean up temp folder
        if (!program.leavetmpdir) {
            fs.rmdirSync(tempFolder, { recursive: true });
        }
    });
});