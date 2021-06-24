const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment');

admin.initializeApp(functions.config().firestore);

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info('Hello logs!', {structuredData: true});
//   response.send('Hello from Firebase!');
// });

exports.newTask = functions.firestore
    .document('tasks/{taskId}')
    .onCreate(async (snap, context) => {
        const newTask = snap.data();
        const userId = newTask.ministry.id;

        const userData = await admin
            .firestore()
            .collection('users')
            .doc(userId)
            .get();

        const user = userData.data();
        const tokens = user.tokens || [];

        const notification = {
            notification: {
                title: 'Uma nova escala pra você!',
                body: `[${newTask.minister.name}] No dia ${moment(newTask.date).format('DD/MM/YY')}${newTask.functions.length > 0 ? ` você tem ${newTask.functions.length > 1 ? 'as funções' : 'a função'}: ${newTask.functions.join(', ')}` : ''}.`
            }
        }

        await sendNotification(tokens, notification, snap.id);
    });

// exports.updateUser = functions.firestore
//     .document('users/{userId}')
//     .onUpdate(async (change, context) => {
//         const id = change.after.id
//         const previousValue = change.before.data()
//         const newValue = change.after.data()

//         functions.logger.info(`-- news ministers: ${newValue.ministers}`)
//         for await (const minister of newValue.ministers) {
//             const previousMinisters = previousValue.ministers.map(m => m.id)
//             if (!previousMinisters.includes(minister.id)) {
//                 admin
//                     .firestore()
//                     .collection('ministers')
//                     .doc(minister.id)
//                     .get()
//                     .then(data => {
//                         let m = data.data()
//                         if (m.users) {
//                             m.users.push(id)
//                         } else {
//                             m.users = [id]
//                         }

//                         admin
//                             .firestore()
//                             .collection(ministers)
//                             .doc(minister.id)
//                             .set({ users: m.users })
//                             .catch(error => {
//                                 functions.logger.error(`An ocorred error while update minister: ${minister.id}`, error)
//                             })
//                     })
//                     .catch(error => {
//                         functions.logger.error(`An ocorred error while find minister: ${minister.id}`, error)
//                     })
//             }
//         }


//     })

exports.sendDailyNotifications = functions.pubsub
    .schedule('0 8 * * *')
    .onRun(async context => {
        let todayStart = moment()
        let todayEnd = moment()
        todayStart.startOf('day')
        todayEnd.endOf('day')

        functions.logger.info(`todayStart: ${todayStart} | todayEnd: ${todayEnd}`)

        const todayTasks = await admin.firestore()
            .collection('tasks')
            .where('date', '>=', todayStart.toDate())
            .where('date', '<=', todayEnd.toDate())
            .get()

        const docs = todayTasks.docs.map(d => ({ id: d.id, ...d.data() }))
        functions.logger.info(`docs: ${JSON.stringify(docs.map(d => d.id))}`)

        for await (const doc of docs) {
            let ministry = await admin.firestore()
                .collection('users')
                .doc(doc.ministry.id)
                .get()
            const tokens = ministry.data().tokens || []

            const notification = {
                notification: {
                    title: 'Não se esquece hein!',
                    body: `Hoje você está escalado(a) no(a) ${doc.minister.name}`
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

exports.sendTomorrowNotifications = functions.pubsub
    .schedule('0 8 * * *')
    .onRun(async context => {
        let tomorrowStart = moment()
        let tomorrowEnd = moment()
        tomorrowStart.add(1, 'day')
        tomorrowEnd.add(1, 'day')
        tomorrowStart.startOf('day')
        tomorrowEnd.endOf('day')

        functions.logger.info(`todayStart: ${todayStart} | todayEnd: ${todayEnd}`)

        const todayTasks = await admin.firestore()
            .collection('tasks')
            .where('date', '>', tomorrowStart.toDate())
            .where('date', '<', tomorrowEnd.toDate())
            .get()

        for await (const doc of todayTasks.docs.map(d => ({ id: d.id, ...d.data() }))) {
            let ministry = await admin.firestore()
                .collection('users')
                .doc(doc.ministry.id)
                .get()
            const tokens = ministry.data().tokens || []

            const notification = {
                notification: {
                    title: 'Não se esquece hein!',
                    body: `Amanhã você está escalado(a) no(a) ${doc.minister.name}`
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

exports.newChangeRequest = functions.firestore
    .document('change-requests/{changeRequestId}')
    .onCreate(async (snap, context) => {
        const newChangeRequest = snap.data();
        const ministerId = newChangeRequest.task.minister.id

        functions.logger.info(`check users from ministerId: ${ministerId}`)

        const usersData = await admin
            .firestore()
            .collection('users')
            .where('ministers', 'array-contains', ministerId)
            .get()

        if (!usersData) return

        const usersFound = usersData.docs
            .filter(d => d.id != newChangeRequest.task.ministry.id)
            .map(d => d.data())
        functions.logger.info(`users found: ${JSON.stringify(usersFound)}`)

        let tokens = usersFound.map(d => d.tokens) || []
        tokens = tokens.flat(2)

        const notification = {
            notification: {
                title: `${newChangeRequest.task.ministry.name} está precisando de ajuda!`,
                body: `[${newChangeRequest.task.minister.name}] Precisa de troca no dia ${moment(newChangeRequest.task.date).format('DD/MM/YY')}.`
            }
        }

        await sendNotification(tokens, notification, snap.id)
    });

async function sendNotification(tokens, notification, taskId) {
    functions.logger.info(`send notification: ${JSON.stringify({ tokens, notification, taskId })}`)

    const notificationResult = await admin
        .messaging()
        .sendToDevice(tokens, notification);

    notificationResult.results.forEach(r => {
        if (r.error) {
            functions.logger.error(`An ocurred error. taskId: ${taskId}`, r.error.message);
        }
    });
}
