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
                body: `No dia ${moment(newTask.date).format('DD/MM/YY')} você tem ${newTask.functions.length > 1 ? 'as funções' : 'a função'}: ${newTask.functions.join(', ')}.`
            }
        }

        await sendNotification(tokens, notification, snap);
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
    .schedule('every 08:00')
    .onRun(context => {
        let todayStart = moment()
        let todayEnd = moment()
        todayStart.startOf('day')
        todayEnd.endOf('day')

        const todayTasks = await admin.firestore()
            .collection('tasks')
            .where('date', '>', todayStart.toDate())
            .where('date', '<', todayEnd.toDate())
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
                    body: `Hoje você está escalado no ministério: ${doc.minister.name}`
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

exports.sendTomorrowNotifications = functions.pubsub
    .schedule('every 08:00')
    .onRun(context => {
        let tomorrowStart = moment()
        let tomorrowEnd = moment()
        tomorrowStart.add(1, 'day')
        tomorrowEnd.add(1, 'day')
        tomorrowStart.startOf('day')
        tomorrowEnd.endOf('day')

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
                    body: `Amanhã você está escalado no ministério: ${doc.minister.name}`
                }
            }

            await sendNotification(tokens, notification, doc.id)
        }
    })

async function sendNotification(tokens, notification, taskId) {
    const notificationResult = await admin
        .messaging()
        .sendToDevice(tokens, notification);

    notificationResult.results.forEach(r => {
        if (r.error) {
            functions.logger.error(`An ocurred error. taskId: ${taskId}`, r.error.message);
        }
    });
}
